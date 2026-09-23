'use client';

import { useState, useEffect, useRef } from 'react';
import InputField from './InputField';
import KeyDownloadButton from './KeyDownloadButton';
import ClusterConfigurationForm from './ClusterConfigurationForm';

type StudentUser = {
  name: string;
  email: string;
  isAdmin: boolean;
  token?: string;
};

type Props = {
  user: StudentUser;
  onLogout: () => void;
  onSwitchToAdmin?: () => void;
};

export default function StudentPortal({ user, onLogout, onSwitchToAdmin }: Props) {
  // Step 1: AWS Credentials (held in component memory only)
  const [awsAccessKey, setAwsAccessKey] = useState('');
  const [awsSecretKey, setAwsSecretKey] = useState('');
  const [isValidatingCreds, setIsValidatingCreds] = useState(false);
  const [credValidationStatus, setCredValidationStatus] = useState<'idle' | 'valid' | 'invalid_account' | 'insufficient_vcpu'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [successBadge, setSuccessBadge] = useState('');
  const [quotaDetails, setQuotaDetails] = useState<{ available_vcpus?: number; region?: string; total_quota?: number; permission_denied?: boolean } | null>(null);

  // Step 2: Unlocked Details (Dynamic single region with >= 36 vCPUs)
  const [targetRegion, setTargetRegion] = useState('us-east-1');
  const [keyPairName, setKeyPairName] = useState('');
  const [keyPairsList, setKeyPairsList] = useState<string[]>([]);
  const [keyPairsLoading, setKeyPairsLoading] = useState(false);
  const [userName, setUserName] = useState(() => user.name || user.email.split('@')[0] || 'student');

  // Step 3: Provisioning & Polling
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeLabId, setActiveLabId] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<'idle' | 'in_progress' | 'completed' | 'error'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [liveStatusText, setLiveStatusText] = useState('');
  const [provisionedServers, setProvisionedServers] = useState<Record<string, any> | null>(null);
  const [isClusterConfigOpen, setIsClusterConfigOpen] = useState(false);
  const [terminateLoading, setTerminateLoading] = useState(false);
  const [terminateMessage, setTerminateMessage] = useState('');

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const stopAllIntervals = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  // -------------------------------------------------------------
  // Verify AWS Credentials & 36-vCPU Quota
  // -------------------------------------------------------------
  const handleVerifyAws = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!awsAccessKey.trim() || !awsSecretKey.trim()) {
      setErrorMessage('Please enter both AWS Access Key and Secret Key.');
      setCredValidationStatus('invalid_account');
      return;
    }

    setIsValidatingCreds(true);
    setErrorMessage('');
    setSuccessBadge('');
    setCredValidationStatus('idle');

    const storedToken = user.token || '';

    try {
      const res = await fetch('/api/validate-aws-cred', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
        },
        body: JSON.stringify({
          aws_access_key: awsAccessKey.trim(),
          aws_secret_key: awsSecretKey.trim(),
          token: storedToken,
          region: targetRegion,
        }),
      });

      const data = await res.json();

      if (!data.valid_account) {
        setCredValidationStatus('invalid_account');
        setErrorMessage(data.message || 'Invalid AWS Credentials. Account not found or inactive.');
        return;
      }

      if (!data.has_required_vcpu) {
        setCredValidationStatus('insufficient_vcpu');
        const quotaInfo = {
          available_vcpus: data.available_vcpus,
          region: data.region || targetRegion,
          total_quota: data.total_quota,
          permission_denied: Boolean(data.permission_denied),
        };
        setQuotaDetails(quotaInfo);
        setErrorMessage(data.message || `Insufficient vCPU Quota: Found ${data.available_vcpus ?? 0} vCPUs in ${targetRegion}. At least 36 vCPUs in one region are required. Please request an increase up to 36+ vCPUs in AWS Service Quotas.`);
        return;
      }

      // PASSED: Valid account & >= 36 vCPUs!
      const verifiedRegion = data.region || targetRegion || 'us-east-1';
      const badge = `✅ AWS Account Verified! Found ${data.available_vcpus} vCPUs in ${verifiedRegion}. Ready to configure.`;
      const verifiedQuota = {
        available_vcpus: data.available_vcpus,
        region: verifiedRegion,
        total_quota: data.total_quota,
      };

      setTargetRegion(verifiedRegion);
      setCredValidationStatus('valid');
      setQuotaDetails(verifiedQuota);
      setSuccessBadge(badge);

      // Fetch Key Pairs for the verified region
      fetchKeyPairs(awsAccessKey.trim(), awsSecretKey.trim(), verifiedRegion);
    } catch (err: any) {
      console.error('[STUDENT-VERIFY] Error:', err);
      setCredValidationStatus('invalid_account');
      setErrorMessage(err?.message || 'Failed to connect to AWS validation service. Please check your credentials and internet connection.');
    } finally {
      setIsValidatingCreds(false);
    }
  };

  const fetchKeyPairs = async (ak: string, sk: string, reg: string) => {
    setKeyPairsLoading(true);
    try {
      const res = await fetch('/api/list-keypairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: ak,
          aws_secret_key: sk,
          region: reg,
        }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.keyPairs)) {
        setKeyPairsList(data.keyPairs);
        if (data.keyPairs.length > 0 && !keyPairName) {
          setKeyPairName(data.keyPairs[0]);
        }
      }
    } catch (err) {
      console.warn('[FETCH-KEYPAIRS] Failed:', err);
    } finally {
      setKeyPairsLoading(false);
    }
  };

  // -------------------------------------------------------------
  // Submit Form: Launch 16 Servers in 1 Region
  // -------------------------------------------------------------
  const handleLaunchLab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (credValidationStatus !== 'valid') {
      setErrorMessage('Please verify your AWS credentials and 36+ vCPU quota first.');
      return;
    }
    if (!keyPairName.trim()) {
      setErrorMessage('Please select or enter an EC2 Key Pair name.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');
    setTerminateMessage('');
    setProvisionedServers(null);
    setSetupState('in_progress');

    const labId = `freelab_${Math.floor(Date.now() / 1000)}`;
    setActiveLabId(labId);

    startPollingStatus(labId);

    try {
      const res = await fetch('/api/submit-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'PROVISION',
          user_name: userName.trim() || 'student',
          user_email: user.email,
          key_pair_name: keyPairName.trim(),
          region: targetRegion,
          aws_access_key: awsAccessKey.trim(),
          aws_secret_key: awsSecretKey.trim(),
          codebuild_projects: ['project 5'],
          lab_id: labId,
        }),
      });

      const data = await res.json();
      if (data.status === 'IN_PROGRESS' || res.status === 200) {
        const servers = data.data?.servers || data.servers;
        if (servers && typeof servers === 'object' && Object.keys(servers).length >= 16) {
          stopAllIntervals();
          setProvisionedServers(servers);
          setSetupState('completed');
          setIsSubmitting(false);
        }
        return;
      }

      if (!res.ok && res.status !== 503 && res.status !== 504) {
        stopAllIntervals();
        setSetupState('error');
        setIsSubmitting(false);
        setErrorMessage(`❌ ${data.message || 'Provisioning request failed'}`);
      }
    } catch (err) {
      console.warn('[LAUNCH-LAB] Continuing status polling:', err);
    }
  };

  // -------------------------------------------------------------
  // Polling for Provisioned Servers
  // -------------------------------------------------------------
  const startPollingStatus = (labId: string) => {
    stopAllIntervals();
    setElapsedSeconds(0);
    const initialStatus = 'Initiating 16 servers in us-east-1 on AWS...';
    setLiveStatusText(initialStatus);
    setSetupState('in_progress');

    timerIntervalRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    let attempts = 0;
    const pollCheck = async () => {
      attempts++;
      try {
        const res = await fetch('/api/lab-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lab_id: labId,
            user_name: userName.trim() || 'student',
            user_email: user.email,
            region: targetRegion,
            aws_access_key: awsAccessKey.trim(),
            aws_secret_key: awsSecretKey.trim(),
          }),
        });

        if (!res.ok) return;

        const data = await res.json();
        if (data.success && data.instance_count > 0) {
          const servers = data.servers || {};
          const serverCount = Object.keys(servers).length;
          const readyWithIps = Object.values(servers).filter(
            (s: any) => s.public_ip && s.public_ip !== 'N/A'
          ).length;

          const statusMsg = `${serverCount}/16 servers created in us-east-1 (${readyWithIps} ready with Public IPs)...`;
          setLiveStatusText(statusMsg);

          if (serverCount >= 16 && readyWithIps >= 16) {
            stopAllIntervals();
            setProvisionedServers(servers);
            setSetupState('completed');
            setIsSubmitting(false);
          }
        }
      } catch (err) {
        console.warn('[STATUS-POLL] Error:', err);
      }

      if (attempts >= 30) {
        stopAllIntervals();
        setIsSubmitting(false);
        const timeoutMsg = 'Provisioning is taking longer than expected. Please check your AWS EC2 Console.';
        setLiveStatusText(timeoutMsg);
      }
    };

    pollIntervalRef.current = setInterval(pollCheck, 10000);
    setTimeout(pollCheck, 10000);
  };

  // -------------------------------------------------------------
  // Terminate Lab
  // -------------------------------------------------------------
  const handleTerminateLab = async () => {
    const confirm = window.confirm(
      'Are you sure you want to terminate all 16 servers? All instances will be cleanly destroyed.'
    );
    if (!confirm) return;

    setTerminateLoading(true);
    setTerminateMessage('Terminating all servers... please wait.');

    try {
      const res = await fetch('/api/submit-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'DESTROY',
          user_name: userName.trim() || 'student',
          user_email: user.email,
          region: targetRegion,
          aws_access_key: awsAccessKey.trim(),
          aws_secret_key: awsSecretKey.trim(),
          lab_id: activeLabId || '',
        }),
      });
      const data = await res.json();
      if (res.ok || data.success) {
        stopAllIntervals();
        setProvisionedServers(null);
        setSetupState('idle');
        setTerminateMessage('✅ All lab servers have been terminated successfully.');
      } else {
        setTerminateMessage(`❌ Failed to terminate: ${data.message || 'Error'}`);
      }
    } catch (err: any) {
      setTerminateMessage(`❌ Error terminating lab: ${err?.message || 'Failed'}`);
    } finally {
      setTerminateLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b pb-4 mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">SoftMania FreeLabs</h2>
          <p className="text-xs text-gray-500">
            Logged in as: <span className="font-semibold text-gray-700">{user.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user.isAdmin && (
            <a
              href="/admin"
              className="text-xs font-semibold px-2.5 py-1 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 border border-purple-200 flex items-center gap-1"
            >
              👑 Admin Console
            </a>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="text-xs text-red-600 hover:text-red-700 font-medium px-2 py-1"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Cluster Configuration Modal */}
      {isClusterConfigOpen && (
        <ClusterConfigurationForm
          onClose={() => setIsClusterConfigOpen(false)}
          provisionedServers={provisionedServers}
        />
      )}

      {/* STEP 1: AWS Credentials Input */}
      <form onSubmit={handleVerifyAws} className="space-y-4">
        <div>
          <InputField
            label="AWS Access Key"
            name="aws_access_key"
            value={awsAccessKey}
            onChange={(e) => {
              setAwsAccessKey(e.target.value);
              setCredValidationStatus('idle');
              setErrorMessage('');
            }}
            placeholder="AKIA..."
            required
            disabled={isValidatingCreds || credValidationStatus === 'valid' || isSubmitting}
          />
        </div>

        <div>
          <InputField
            label="AWS Secret Key"
            name="aws_secret_key"
            type="password"
            value={awsSecretKey}
            onChange={(e) => {
              setAwsSecretKey(e.target.value);
              setCredValidationStatus('idle');
              setErrorMessage('');
            }}
            placeholder="Enter your secret key"
            required
            disabled={isValidatingCreds || credValidationStatus === 'valid' || isSubmitting}
          />
        </div>

        {/* Action Button: Verify Account */}
        {credValidationStatus !== 'valid' && (
          <button
            type="submit"
            disabled={isValidatingCreds || !awsAccessKey.trim() || !awsSecretKey.trim()}
            className="w-full py-2.5 px-4 bg-blue-600 text-white font-semibold rounded-lg shadow hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isValidatingCreds ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Verifying Account &amp; 36-vCPU Quota...</span>
              </>
            ) : (
              <span>Verify AWS Account &amp; 36-vCPU Quota</span>
            )}
          </button>
        )}
      </form>

      {/* ERROR STATES: RED TEXT MESSAGES */}
      {credValidationStatus === 'invalid_account' && (
        <div className="mt-4 p-3.5 bg-red-50 border border-red-200 rounded-xl text-left">
          <p className="text-sm font-bold text-red-700 flex items-center gap-1.5">
            <span>❌ Invalid AWS Credentials</span>
          </p>
          <p className="text-xs text-red-600 mt-1">
            {errorMessage || 'Account not found or credentials are inactive. Please verify your Access Key ID and Secret Access Key.'}
          </p>
        </div>
      )}

      {credValidationStatus === 'insufficient_vcpu' && (
        <div className="mt-4 p-4 bg-red-50 border-2 border-red-300 rounded-xl text-left">
          {quotaDetails?.permission_denied ? (
            <>
              <p className="text-sm font-extrabold text-red-700 flex items-center gap-1.5">
                <span>⚠️ Missing IAM Permission: ServiceQuotasReadOnlyAccess</span>
              </p>
              <p className="text-xs text-red-700 mt-1.5 leading-relaxed">
                Your IAM user has valid EC2 access, but AWS blocked reading your vCPU quota because your IAM user is missing the <code className="bg-red-100 px-1 py-0.5 rounded font-mono text-red-900 font-bold">servicequotas:GetServiceQuota</code> permission.
              </p>
              <p className="text-xs text-red-800 font-semibold mt-2">
                💡 Your account likely already has enough vCPUs, but your IAM user cannot read the limit!
              </p>
              <div className="mt-3 pt-2.5 border-t border-red-200 text-[11px] text-red-700 space-y-1">
                <p className="font-bold text-red-900">How to fix in 30 seconds:</p>
                <p>1. Open AWS Console → Search for <strong>IAM</strong> → Click <strong>Users</strong>.</p>
                <p>2. Select this IAM User → Under <strong>Permissions policies</strong>, click <strong>Add permissions</strong> → <strong>Attach policies directly</strong>.</p>
                <p>3. Search for <strong>ServiceQuotasReadOnlyAccess</strong>, check the box, and click <strong>Add permissions</strong>.</p>
                <p>4. Return here and click <strong>Verify AWS Account &amp; 36-vCPU Quota</strong> again.</p>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-extrabold text-red-700 flex items-center gap-1.5">
                <span>❌ Insufficient vCPU Quota</span>
              </p>
              <p className="text-xs text-red-700 mt-1.5 leading-relaxed">
                Your AWS account in <strong className="underline">{quotaDetails?.region || 'us-east-1'}</strong> currently has{' '}
                <strong className="text-red-900 bg-red-100 px-1 py-0.5 rounded">{quotaDetails?.available_vcpus ?? 0} vCPUs</strong> available.
              </p>
              <p className="text-xs text-red-800 font-semibold mt-2">
                ⚠️ You need at least <strong>36 vCPUs</strong> in a single region to launch FreeLabs.
              </p>
              <div className="mt-3 pt-2.5 border-t border-red-200 text-[11px] text-red-700 space-y-1">
                <p className="font-bold text-red-900">How to increase your quota:</p>
                <p>1. Open AWS Console → Search for <strong>Service Quotas</strong> in <code>us-east-1</code>.</p>
                <p>2. Select <strong>Amazon EC2</strong> → Search: <code>Running On-Demand Standard instances</code> (L-1216C47A).</p>
                <p>3. Click <strong>Request quota increase</strong> and enter <strong>64</strong>.</p>
                <p>4. Once AWS approves the request, return here and click <strong>Verify</strong> again.</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* SUCCESS BADGE */}
      {credValidationStatus === 'valid' && successBadge && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 text-green-800 text-xs rounded-xl flex items-center justify-between">
          <span>{successBadge}</span>
          <button
            type="button"
            onClick={() => {
              setCredValidationStatus('idle');
              setSuccessBadge('');
            }}
            className="text-[11px] text-green-700 underline hover:text-green-900 ml-2"
          >
            Change Keys
          </button>
        </div>
      )}

      {/* STEP 2: UNLOCKED FORM (Only visible after valid credentials & >= 36 vCPUs) */}
      {credValidationStatus === 'valid' && (
        <form onSubmit={handleLaunchLab} className="mt-6 pt-6 border-t border-gray-200 space-y-4">
          <div className="flex items-center justify-between bg-blue-50/60 p-3 rounded-lg border border-blue-100">
            <div>
              <p className="text-xs font-semibold text-blue-900">Target Region</p>
              <p className="text-xs text-blue-700">{targetRegion} — 1 Single Region</p>
            </div>
            <span className="text-[11px] bg-blue-100 text-blue-800 font-medium px-2 py-0.5 rounded">
              {quotaDetails?.available_vcpus ?? 36} vCPUs Verified
            </span>
          </div>

          {/* Key Pair Selection */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-700 mb-1">
              EC2 Key Pair ({targetRegion})
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                list="keypairs-list"
                value={keyPairName}
                onChange={(e) => setKeyPairName(e.target.value)}
                placeholder="Select or enter your key pair name"
                className="w-full border rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                disabled={isSubmitting}
              />
              <datalist id="keypairs-list">
                {keyPairsList.map((kp) => (
                  <option key={kp} value={kp} />
                ))}
              </datalist>
              <KeyDownloadButton
                awsAccessKey={awsAccessKey}
                awsSecretKey={awsSecretKey}
                region={targetRegion}
                keyPairName={keyPairName}
                disabled={!keyPairName.trim() || isSubmitting}
              />
            </div>
            {keyPairsLoading && (
              <p className="text-[11px] text-gray-400 mt-1">Loading key pairs from {targetRegion}...</p>
            )}
          </div>

          {/* Username (Pre-filled) */}
          <div>
            <InputField
              label="Student Username"
              name="userName"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g. rahul"
              required
              disabled={isSubmitting}
            />
          </div>

          {/* Launch Button */}
          <button
            type="submit"
            disabled={isSubmitting || !keyPairName.trim()}
            className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold rounded-xl shadow-lg hover:from-blue-700 hover:to-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Deploying 16 Servers in us-east-1...</span>
              </>
            ) : (
              <span>🚀 Launch FreeLabs Environment</span>
            )}
          </button>
        </form>
      )}

      {/* PROVISIONING PROGRESS & STATUS */}
      {setupState === 'in_progress' && (
        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-xl text-center">
          <p className="text-sm font-semibold text-blue-900 animate-pulse">{liveStatusText}</p>
          <p className="text-xs text-blue-600 mt-1">Time elapsed: {elapsedSeconds}s</p>
        </div>
      )}

      {/* COMPLETED SERVERS DISPLAY */}
      {setupState === 'completed' && provisionedServers && (
        <div className="mt-6 pt-4 border-t border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold text-green-700">
              ✅ All 16 Servers Created in us-east-1!
            </span>
            <button
              type="button"
              onClick={() => setIsClusterConfigOpen(true)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow"
            >
              Cluster Configuration →
            </button>
          </div>

          <div className="max-h-52 overflow-y-auto space-y-1 bg-gray-50 p-2.5 rounded-lg border text-xs">
            {Object.entries(provisionedServers).map(([sName, sData]: [string, any]) => (
              <div key={sName} className="flex justify-between items-center py-1 border-b last:border-0">
                <span className="font-semibold text-gray-800">{sName}</span>
                <span className="text-gray-600 font-mono">{sData.public_ip || sData.private_ip || 'N/A'}</span>
              </div>
            ))}
          </div>

          {/* Terminate Button */}
          <div className="mt-4 pt-3 border-t flex justify-end">
            <button
              type="button"
              onClick={handleTerminateLab}
              disabled={terminateLoading}
              className="text-xs text-red-600 hover:text-red-800 font-semibold px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 transition"
            >
              {terminateLoading ? 'Terminating...' : '🗑️ Terminate All Lab Servers'}
            </button>
          </div>
        </div>
      )}

      {terminateMessage && (
        <p className="text-xs text-center mt-3 font-semibold text-gray-700">{terminateMessage}</p>
      )}
    </div>
  );
}
