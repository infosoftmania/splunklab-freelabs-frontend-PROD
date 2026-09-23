'use client';

import { useState, useEffect, useRef } from 'react';
import InputField from './InputField';
import KeyDownloadButton from './KeyDownloadButton';
import ClusterConfigurationForm from './ClusterConfigurationForm';
import { readLabId, writeLabId, readAwsCredentials, removeAwsCredentials, writeAwsCredentials } from '../lib/lab-storage';
import environments from '../data/environments.json';
import awsRegions from '../data/awsRegions.json';

type AdminFormData = {
  aws_access_key: string;
  aws_secret_key: string;
  region: string;
  key_pair_name: string;
  user_email: string;
  user_name: string;
  codebuild_projects: string[];
};

type AwsFormProps = {
  userEmail?: string;
  userName?: string;
};

export default function AwsForm({ userEmail = '', userName = '' }: AwsFormProps) {
  const [selectedGroup, setSelectedGroup] = useState('project_5');
  const [awsValid, setAwsValid] = useState<boolean | null>(null);
  const [keyPairValid, setKeyPairValid] = useState<boolean | null>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [isClusterConfigurationOpen, setIsClusterConfigurationOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const [awsAccessMessage, setAwsAccessMessage] = useState('');
  const [awsSecretMessage, setAwsSecretMessage] = useState('');
  const [keyPairMessage, setKeyPairMessage] = useState('');
  const [keyPairsLoading, setKeyPairsLoading] = useState(false);
  const [isEmailValid, setIsEmailValid] = useState(Boolean(userEmail));

  const [keyPairsList, setKeyPairsList] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  const [vpcMessage, setVpcMessage] = useState('');
  const [vpcChecking, setVpcChecking] = useState(false);
  const [vpcAllowed, setVpcAllowed] = useState<boolean | null>(null);
  type VpcCheckStatus = 'idle' | 'loading' | 'success' | 'error';

  const [vpcStatus, setVpcStatus] = useState<VpcCheckStatus>('idle');

  // Multi-server provisioning states
  const [setupState, setSetupState] = useState<'idle' | 'in_progress' | 'completed' | 'error'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [liveStatusText, setLiveStatusText] = useState('');
  const [activeLabId, setActiveLabId] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [provisionedServers, setProvisionedServers] = useState<Record<string, { public_ip?: string; private_ip?: string; region?: string; instance_type?: string }> | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [formData, setFormData] = useState<AdminFormData>(() => ({
    aws_access_key: '',
    aws_secret_key: '',
    region: '',
    key_pair_name: '',
    user_email: userEmail,
    user_name: userName,
    codebuild_projects: ['project 5'] as string[],
  }));
  const codebuildGroupOptions = Object.entries(environments).map(
    ([key, value]) => ({
      label: value.label,
      value: key,
    })
  );

  useEffect(() => {
    if (!activeLabId) {
      const storedLabId = readLabId();
      if (storedLabId) setActiveLabId(storedLabId);
    }

    if (!formData.user_email.trim() || formData.aws_access_key || formData.aws_secret_key) return;

    const storedAwsCredentials = readAwsCredentials(formData.user_email);
    if (!storedAwsCredentials) return;

    setFormData((current) => ({
      ...current,
      aws_access_key: storedAwsCredentials.accessKey,
      aws_secret_key: storedAwsCredentials.secretKey,
      region: storedAwsCredentials.region || current.region,
    }));
    
    if (storedAwsCredentials.status === 'valid') {
      setAwsValid(true);
      setAwsAccessMessage('AWS Access Key restored');
      setAwsSecretMessage('AWS Secret Key restored');
    }
  }, [formData.user_email, formData.aws_access_key, formData.aws_secret_key, activeLabId]);
  // Input handlers
  // -------------------------
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    // AWS fields reset
    if (['aws_access_key', 'aws_secret_key', 'region'].includes(name)) {
            writeAwsCredentials(formData.user_email, {
              accessKey: formData.aws_access_key.trim(),
              secretKey: formData.aws_secret_key.trim(),
              status: 'valid',
              region: formData.region || 'us-east-1',
              updatedAt: new Date().toISOString(),
            });
      setAwsValid(null);
      setKeyPairValid(null);
    }

    if (name === 'key_pair_name') {
      setKeyPairValid(null);
            removeAwsCredentials(formData.user_email);
    }

    // Validate email
    if (name === 'user_email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          removeAwsCredentials(formData.user_email);
      setIsEmailValid(emailRegex.test(value));
      setFormData(prev => ({ ...prev, user_email: value }));
      return;
    }

    if (name === 'user_name') {
      setFormData(prev => ({ ...prev, user_name: value }));
      return;
    }

    setFormData(prev => ({ ...prev, [name]: value }));
  };

  // -------------------------
  // -------------------------
  // Fetch key pairs helper
  // -------------------------
  const fetchKeyPairsForRegion = async (reg: string) => {
    if (!formData.aws_access_key || !formData.aws_secret_key || !reg) return;

    setKeyPairsLoading(true);
    try {
      const res = await fetch('/api/list-keypairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: formData.aws_access_key.trim(),
          aws_secret_key: formData.aws_secret_key.trim(),
          region: reg,
        }),
      });
      const data = await res.json();

      if (data.success && Array.isArray(data.keyPairs)) {
        setKeyPairsList(data.keyPairs);
      }
    } catch (err) {
      console.error('Failed to fetch key pairs', err);
    } finally {
      setKeyPairsLoading(false);
    }
  };

  const handleRegionChange = async (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const region = e.target.value;

    setFormData(prev => ({
      ...prev,
      region,
      key_pair_name: '',
    }));

    setKeyPairsList([]);
    setShowDropdown(false);
    setKeyPairMessage('');
    setKeyPairValid(null);

    fetchKeyPairsForRegion(region);
  };


const handleGroupChange = (
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) => {
  const groupKey = e.target.value;
  setSelectedGroup(groupKey);

  const env = environments[groupKey as keyof typeof environments];
  const projects = env?.codebuild_projects || ['project 5'];

  setFormData(prev => ({
    ...prev,
    codebuild_projects: projects,
  }));
};




  // -------------------------
  // Validate AWS Access Key & Secret Key
  // -------------------------
  const validateAws = async () => {
    if (!formData.aws_access_key.trim() || !formData.aws_secret_key.trim()) return;

    setIsValidating(true);
    setAwsAccessMessage('');
    setAwsSecretMessage('');
    setKeyPairMessage('');

    try {
      const res = await fetch('/api/validate-aws-cred', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: formData.aws_access_key.trim(),
          aws_secret_key: formData.aws_secret_key.trim(),
          region: formData.region || 'us-east-1',
          user_email: formData.user_email,
        }),
      });

      const data = await res.json();

      if (!data.valid_account) {
        const errorMsg = data.message || 'Invalid AWS credentials';
        setAwsAccessMessage(errorMsg);
        setAwsSecretMessage(errorMsg);
        setAwsValid(false);
      } else if (!data.has_required_vcpu) {
        const errorMsg = data.message || 'Insufficient vCPU quota';
        setAwsAccessMessage(errorMsg);
        setAwsSecretMessage(errorMsg);
        setAwsValid(false);
      } else {
        setAwsAccessMessage('AWS Access Key is valid');
        setAwsSecretMessage('AWS Secret Key is valid');
        setAwsValid(true);
        if (data.region) {
          setFormData((prev) => ({ ...prev, region: data.region }));
          fetchKeyPairsForRegion(data.region);
        } else if (formData.region) {
          fetchKeyPairsForRegion(formData.region);
        }
        if (activeLabId) startPollingStatus(activeLabId, data.region || formData.region, formData.user_email, formData.user_name);
      }
    } catch (err) {
      console.error(err);
      setAwsAccessMessage('Error validating AWS credentials');
      setAwsSecretMessage('Error validating AWS credentials');
      setAwsValid(false);
    } finally {
      setIsValidating(false);
    }
  };

  // -------------------------
  // Cleanup intervals on unmount
  // -------------------------
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

  useEffect(() => {
    if (!formData.user_email.trim() || activeLabId) return;

    const storedLabId = readLabId();
    if (storedLabId) setActiveLabId(storedLabId);
  }, [formData.user_email, activeLabId]);

  // -------------------------
  // Status Polling for 16 Servers
  // -------------------------
  const startPollingStatus = (labId: string, currentRegion?: string, currentEmail?: string, currentName?: string) => {
    stopAllIntervals();
    setElapsedSeconds(0);
    setLiveStatusText('Initiating 16 servers on AWS...');
    setSetupState('in_progress');

    // Timer: counts up every second
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
            user_name: (currentName !== undefined ? currentName : formData.user_name).trim() || 'student',
            user_email: (currentEmail !== undefined ? currentEmail : formData.user_email).trim(),
            region: currentRegion || formData.region,
            aws_access_key: formData.aws_access_key,
            aws_secret_key: formData.aws_secret_key,
          }),
        });

        if (!res.ok) return;

        const data = await res.json();
        if (data.success && data.instance_count > 0) {
          const servers = data.servers || {};
          writeLabId(labId);
          const serverCount = Object.keys(servers).length;

          // Count instances with public IP assigned
          const readyWithIps = Object.values(servers).filter(
            (s: any) => s.public_ip && s.public_ip !== 'N/A'
          ).length;

          setLiveStatusText(`${serverCount}/16 servers created (${readyWithIps} ready with Public IPs)...`);

          // When all 16 servers are ready with public IPs
          if (serverCount >= 16 && readyWithIps >= 16) {
            stopAllIntervals();
            setProvisionedServers(servers);
            setSetupState('completed');
            setIsSubmitting(false);
            setSuccessMessage('✅ Environment setup done! All 16 servers are ready.');
            writeLabId(labId);
          }
        }
      } catch (err) {
        console.warn('[STATUS-POLL] Error checking status:', err);
      }

      // Safety timeout after ~4 minutes
      if (attempts >= 25) {
        stopAllIntervals();
        setIsSubmitting(false);
        setLiveStatusText('Provisioning is taking longer than expected. Check your AWS EC2 Console.');
      }
    };

    // Poll every 10 seconds
    pollIntervalRef.current = setInterval(pollCheck, 10000);
    setTimeout(pollCheck, 10000);
  };

  // -------------------------
  // Check Existing Running Servers
  // -------------------------
  const checkExistingStatus = async () => {
    if (!formData.aws_access_key || !formData.aws_secret_key || !formData.region || !formData.user_name.trim()) {
      setSuccessMessage('❌ Enter AWS credentials, region, and username to check existing status');
      return;
    }

    setIsCheckingStatus(true);
    setSuccessMessage('Checking for running servers in your AWS account...');

    try {
      const res = await fetch('/api/lab-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lab_id: activeLabId || '',
          user_name: formData.user_name.trim(),
          user_email: formData.user_email.trim(),
          region: formData.region,
          aws_access_key: formData.aws_access_key,
          aws_secret_key: formData.aws_secret_key,
        }),
      });

      const data = await res.json();
      if (data.success && data.instance_count > 0 && data.servers && Object.keys(data.servers).length > 0) {
        if (data.lab_id) {
          setActiveLabId(data.lab_id);
          writeLabId(data.lab_id);
        }
        setProvisionedServers(data.servers);
        setSetupState('completed');
        setSuccessMessage(`✅ Found ${data.instance_count} active servers in your account!`);
      } else {
        setSuccessMessage('ℹ️ No active servers found. Click Submit to create them.');
      }
    } catch (err: any) {
      setSuccessMessage(`❌ Status check error: ${err?.message || 'Failed'}`);
    } finally {
      setIsCheckingStatus(false);
    }
  };

  // -------------------------
  // Submit Form (PROVISION)
  // -------------------------
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (awsValid !== true) {
      setSuccessMessage('❌ Please validate AWS credentials first');
      return;
    }

    setIsSubmitting(true);
    setSuccessMessage('');
    setProvisionedServers(null);
    setSetupState('in_progress');

    const labId = `freelab_${Math.floor(Date.now() / 1000)}`;
    setActiveLabId(labId);
    writeLabId(labId);

    const payload = {
      action: 'PROVISION',
      user_name: formData.user_name.trim() || 'student',
      user_email: formData.user_email.trim() || `${formData.user_name.trim()}@freelabs.io`,
      key_pair_name: formData.key_pair_name,
      region: formData.region,
      aws_access_key: formData.aws_access_key,
      aws_secret_key: formData.aws_secret_key,
      codebuild_projects: ['project 5'],
      lab_id: labId,
    };

    // Immediately start UI timer and live status polling
    startPollingStatus(labId, formData.region, formData.user_email, formData.user_name);

    try {
      const res = await fetch('/api/submit-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      // If backend returned immediate 200 with IN_PROGRESS: keep polling!
      if (data.status === 'IN_PROGRESS' || res.status === 200) {
        const servers = data.data?.servers || data.servers;
        if (servers && typeof servers === 'object' && Object.keys(servers).length >= 16) {
          stopAllIntervals();
          setProvisionedServers(servers);
          setSetupState('completed');
          setIsSubmitting(false);
          setSuccessMessage('✅ Environment setup done! All 16 servers are ready.');
        }
        return;
      }

      // If real error occurred (not a timeout)
      if (!res.ok && res.status !== 503 && res.status !== 504) {
        stopAllIntervals();
        setSetupState('error');
        setIsSubmitting(false);
        setSuccessMessage(`❌ ${data.message || 'Provisioning request failed'}`);
      }
    } catch (err) {
      // If network dropped or timed out, the background Lambda is still creating instances, so polling continues!
      console.warn('[SUBMIT-FORM] Initial POST returned, continuing status polling:', err);
    }
  };




  // -------------------------
  // UI
  // -------------------------
  return (
    <>
      <button
        type="button"
        onClick={() => setIsClusterConfigurationOpen(true)}
        className="fixed right-4 top-4 z-40 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow hover:bg-blue-700"
      >
        Cluster Configuration
      </button>
    <form onSubmit={handleSubmit} className="bg-white p-9 rounded shadow space-y-3">
      {/* AWS Access Key */}
      {/* AWS Access Key */}
<div className="items-center gap-2">
  <InputField
    label="AWS Access Key"
    name="aws_access_key"
    value={formData.aws_access_key}
    onChange={handleChange}
    required
    disabled={awsValid === true} // disable after successful validation
  />
  {awsAccessMessage && (
    <p className={`text-sm ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
      {awsAccessMessage}
    </p>
  )}
</div>

{/* AWS Secret Key */}
<div className="items-center gap-2">
  <InputField
    label="AWS Secret Key"
    name="aws_secret_key"
    type="password"
    value={formData.aws_secret_key}
    onChange={handleChange}
    required
    disabled={awsValid === true} // disable after successful validation
  />
  {awsSecretMessage && (
    <p className={`text-sm ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
      {awsSecretMessage}
    </p>
  )}
</div>


      <div className="flex gap-2 items-center">
        <button
          type="button"
          disabled={isValidating}
          onClick={validateAws}
          className={`px-3 py-2 rounded text-white font-medium ${isValidating ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {isValidating ? 'Validating...' : 'Validate AWS'}
        </button>

        <button
          type="button"
          disabled={isCheckingStatus || !formData.aws_access_key || !formData.user_name.trim()}
          onClick={checkExistingStatus}
          className={`px-3 py-2 rounded text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors ${
            isCheckingStatus || !formData.aws_access_key || !formData.user_name.trim()
              ? 'opacity-50 cursor-not-allowed'
              : ''
          }`}
          title="Load your existing active servers"
        >
          {isCheckingStatus ? 'Loading...' : 'Load Dashboard'}
        </button>
      </div>

      {/* AWS Region */}
      <div className="items-center gap-2">
        <InputField
          label="AWS Region"
          name="region"
          type="select"
          value={formData.region}
          onChange={handleRegionChange}
          options={awsRegions.map(r => ({ label: r, value: r }))}
          required
        />
      </div>

      {/* PEM Key */}
      {/* PEM Key (show ONLY after region is selected) */}
{/* PEM Key section — show ONLY after region is selected */}
{formData.region && (
  <>
    <div className="relative w-[400px]">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        PEM Key Name
      </label>

      <input
        type="text"
        name="key_pair_name"
        value={
          keyPairsLoading ? 'Loading key pairs…' : formData.key_pair_name
        }
        onChange={handleChange}
        placeholder="Select or enter PEM key name"
        disabled={keyPairsLoading}
        className={`mt-1 block w-full h-[48px] rounded-md shadow-sm px-3 pr-10 text-sm
          ${
            keyPairsLoading
              ? 'bg-gray-100 cursor-not-allowed border-gray-300'
              : 'border border-gray-300'
          }
        `}
        onFocus={() => !keyPairsLoading && setShowDropdown(true)}
        autoComplete="off"
        required
      />

      {/* Loading spinner */}
      {keyPairsLoading && (
        <div className="absolute right-3 top-12 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
        </div>
      )}

      {/* Dropdown arrow */}
      {!keyPairsLoading && keyPairsList.length > 0 && (
        <button
          type="button"
          className="absolute right-2 top-12 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          onClick={() => setShowDropdown(prev => !prev)}
        >
          ▼
        </button>
      )}

      {/* Dropdown list */}
      {!keyPairsLoading && showDropdown && keyPairsList.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-auto rounded-md border border-gray-300 bg-white shadow-lg">
          {keyPairsList.map((kp) => (
            <li
              key={kp}
              className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
              onMouseDown={() => {
                setFormData(prev => ({
                  ...prev,
                  key_pair_name: kp,
                }));
                setShowDropdown(false);
              }}
            >
              {kp}
            </li>
          ))}
        </ul>
      )}

      {/* Status message */}
      {keyPairMessage && (
        <p
          className={`mt-1 text-sm ${
            keyPairValid ? 'text-green-600' : 'text-red-600'
          }`}
        >
          {keyPairMessage}
        </p>
      )}
    </div>

    {/* Create / Download button */}
    <KeyDownloadButton
      awsAccessKey={formData.aws_access_key}
      awsSecretKey={formData.aws_secret_key}
      region={formData.region}
      keyPairName={formData.key_pair_name}
      disabled={keyPairsLoading}
    />
  </>
)}



      {/* CodeBuild Group */}
      <InputField
        label="Environments"
        name="codebuild_group"
        type="select"
        value={selectedGroup}
        onChange={handleGroupChange}
        options={codebuildGroupOptions}
        required
      />



      {/* Username */}
      <InputField
        label="Username"
        name="user_name"
        type="text"
        value={formData.user_name}
        onChange={handleChange}
        required
        placeholder="Enter your username (e.g. jayasurya)"
      />

      {/* Email */}
      <InputField
        label="Email"
        name="user_email"
        type="email"
        value={formData.user_email}
        onChange={handleChange}
        required
        placeholder="Enter your email"
      />

      {/* Submit Button */}
      <button
        type="submit"
        disabled={
          isSubmitting ||
          setupState === 'in_progress' ||
          awsValid !== true ||
          !isEmailValid ||
          !formData.user_name.trim()
        }
        className={`border w-[400px] mt-2 py-3 rounded-lg text-lg font-semibold text-white transition-all
          ${
            isSubmitting ||
            setupState === 'in_progress' ||
            awsValid !== true ||
            !isEmailValid ||
            !formData.user_name.trim()
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-black hover:bg-gray-800 shadow-md hover:shadow-lg'
          }`}
      >
        {setupState === 'in_progress'
          ? 'Environment setup in progress...'
          : isSubmitting
          ? 'Starting Provisioning...'
          : 'Create Environment'}
      </button>

      {/* Progress Banner: Environment setup, please wait... */}
      {setupState === 'in_progress' && (
        <div className="mt-4 p-4 border border-blue-300 rounded-lg bg-blue-50 shadow-sm max-w-[420px]">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <div>
              <h4 className="text-sm font-bold text-blue-900">
                Environment setup, please wait...
              </h4>
              <p className="text-xs text-blue-700 mt-0.5">
                Creating 16 servers on AWS ({formData.region || 'us-east-1'}). Time elapsed: <strong>{elapsedSeconds}s</strong>
              </p>
            </div>
          </div>

          <div className="w-full bg-blue-200 rounded-full h-2 mt-3 overflow-hidden">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.min(95, Math.max(8, (elapsedSeconds / 45) * 100))}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-blue-800 mt-2 font-medium">
            <span>{liveStatusText || 'Creating EC2 instances...'}</span>
            <span>~45s total</span>
          </div>
        </div>
      )}

      {/* Error / Simple Info Message */}
      {successMessage && setupState !== 'in_progress' && (
        <p
          className={`text-center mt-2 font-medium text-sm ${
            successMessage.startsWith('✅') ? 'text-green-600' : 'text-red-600'
          }`}
        >
          {successMessage}
        </p>
      )}

      {/* Completed Banner: Environment setup done! */}
      {setupState === 'completed' && provisionedServers && (
        <div className="mt-4 p-4 border-2 border-green-400 rounded-lg bg-green-50 shadow-md max-w-[420px]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xl">✅</span>
              <div>
                <h3 className="text-sm font-bold text-green-900">
                  Environment setup done!
                </h3>
                <p className="text-xs text-green-700">
                  All {Object.keys(provisionedServers).length} servers are running and ready.
                </p>
              </div>
            </div>
            <span className="text-xs bg-green-200 text-green-800 px-2 py-0.5 rounded-full font-bold">
              Active
            </span>
          </div>

          {/* Cluster Configuration Callout */}
          <div className="bg-white p-3 rounded-md border border-green-200 mb-3 shadow-sm">
            <p className="text-xs text-gray-700 mb-2 font-medium">
              👉 <strong>Next Step:</strong> Copy the server <strong>Public IPs</strong> below, then click below to log in with your Gmail and configure your Splunk cluster:
            </p>
            <button
              type="button"
              onClick={() => setIsClusterConfigurationOpen(true)}
              className="w-full py-2.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow flex items-center justify-center gap-2 transition-all hover:shadow-md active:scale-95"
            >
              <span>🚀 Open Cluster Configuration</span>
            </button>
          </div>

          {/* Multi-Region Explanation Note */}
          <div className="text-[11px] text-gray-600 bg-gray-50 p-2 rounded border border-gray-200 mb-2">
            💡 <em>Servers are distributed across AWS regions (e.g. <code>us-west-1</code>, <code>us-west-2</code>, <code>ap-south-1</code>) to balance vCPU limits, each with a dedicated Public Elastic IP. Select the corresponding region in your AWS Console to view them.</em>
          </div>

          {/* Server List */}
          <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
            {Object.entries(provisionedServers).map(([srvName, srvInfo]) => {
              const pubIp =
                typeof srvInfo === 'object' && srvInfo
                  ? srvInfo.public_ip || srvInfo.private_ip || ''
                  : String(srvInfo || '');
              const srvRegion = typeof srvInfo === 'object' && srvInfo ? srvInfo.region : undefined;
              return (
                <div
                  key={srvName}
                  className="flex items-center justify-between bg-white p-2 rounded border border-gray-200 text-xs shadow-sm hover:border-blue-300 transition-colors"
                >
                  <div className="flex items-center gap-1.5 truncate max-w-[190px]">
                    <span className="font-semibold text-gray-800 truncate" title={srvName}>
                      {srvName}
                    </span>
                    {srvRegion && (
                      <span className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded border border-purple-200 font-mono flex-shrink-0" title={`AWS Region: ${srvRegion}`}>
                        {srvRegion}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="text-right">
                      <code className="block text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded font-mono text-[11px] font-medium">
                        Public: {pubIp || 'N/A'}
                      </code>
                      <code className="block text-gray-600 bg-gray-50 px-1.5 py-0.5 rounded font-mono text-[11px]">
                        Private: {typeof srvInfo === 'object' && srvInfo ? srvInfo.private_ip || 'N/A' : 'N/A'}
                      </code>
                    </div>
                    {pubIp && (
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(pubIp);
                          setCopiedKey(srvName);
                          setTimeout(() => setCopiedKey(null), 2000);
                        }}
                        className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                          copiedKey === srvName
                            ? 'bg-green-100 text-green-800 border-green-300 font-bold'
                            : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-300'
                        }`}
                      >
                        {copiedKey === srvName ? '✓ Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </form>
      {isClusterConfigurationOpen && (
        <ClusterConfigurationForm
          onClose={() => setIsClusterConfigurationOpen(false)}
          provisionedServers={provisionedServers}
          hideAuth={true}
          userEmail={formData.user_email}
        />
      )}
    </>
  );
}
