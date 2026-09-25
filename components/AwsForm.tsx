'use client';

import { useState, useEffect, useRef } from 'react';
import InputField from './InputField';
import KeyDownloadButton from './KeyDownloadButton';
import ClusterConfigurationForm from './ClusterConfigurationForm';
import { readLabId, writeLabId, removeLabId, readAwsCredentials, removeAwsCredentials, writeAwsCredentials } from '../lib/lab-storage';
import { parseAwsValidationResponse } from '../lib/aws-validation';
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
  token?: string;
};

type RegionQuotaSummary = {
  region: string;
  region_name?: string;
  allocated_instances?: number;
  allocated_eips?: number;
  available_vcpus: number;
  quota_vcpus: number;
  used_vcpus: number;
  available_eips: number;
  quota_eips: number;
  used_eips: number;
};

export default function AwsForm({ userEmail = '', userName = '', token = '' }: AwsFormProps) {
  const [selectedGroup, setSelectedGroup] = useState('project_5');
  const [awsValid, setAwsValid] = useState<boolean | null>(null);
  const [regionsSummary, setRegionsSummary] = useState<RegionQuotaSummary[] | null>(null);
  const [isMultiRegionMode, setIsMultiRegionMode] = useState<boolean>(false);
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
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const keyPairDropdownRef = useRef<HTMLDivElement | null>(null);

  const filteredKeyPairs = keyPairsList.filter((kp) =>
    kp.toLowerCase().includes(formData.key_pair_name.toLowerCase().trim())
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (keyPairDropdownRef.current && !keyPairDropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setHighlightedIndex(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyPairKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (keyPairsLoading) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!showDropdown) {
        setShowDropdown(true);
        setHighlightedIndex(0);
      } else if (filteredKeyPairs.length > 0) {
        setHighlightedIndex((prev) =>
          prev === null || prev >= filteredKeyPairs.length - 1 ? 0 : prev + 1
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (showDropdown && filteredKeyPairs.length > 0) {
        setHighlightedIndex((prev) =>
          prev === null || prev <= 0 ? filteredKeyPairs.length - 1 : prev - 1
        );
      }
    } else if (e.key === 'Enter') {
      if (
        showDropdown &&
        highlightedIndex !== null &&
        highlightedIndex >= 0 &&
        highlightedIndex < filteredKeyPairs.length
      ) {
        e.preventDefault();
        setFormData((prev) => ({
          ...prev,
          key_pair_name: filteredKeyPairs[highlightedIndex],
        }));
        setShowDropdown(false);
        setHighlightedIndex(null);
      }
    } else if (e.key === 'Escape') {
      if (showDropdown) {
        e.preventDefault();
        setShowDropdown(false);
        setHighlightedIndex(null);
      }
    }
  };

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
  const [isDestroyModalOpen, setIsDestroyModalOpen] = useState(false);
  const [destroyConfirmChecked, setDestroyConfirmChecked] = useState(false);
  const [terminateLoading, setTerminateLoading] = useState(false);
  const [terminateMessage, setTerminateMessage] = useState('');

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
    const email = (formData.user_email || userEmail).trim();
    if (!activeLabId && email) {
      const storedLabId = readLabId(email);
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
      setRegionsSummary(null);
      setIsMultiRegionMode(false);
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
      const res = await fetch('/api/keypair-validation/list', {
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
    setRegionsSummary(null);
    setIsMultiRegionMode(false);

    try {
      const activeToken = token || '';

      const res = await fetch('/api/validate-aws-cred', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(activeToken ? { Authorization: `Bearer ${activeToken}` } : {}),
        },
        body: JSON.stringify({
          aws_access_key: formData.aws_access_key.trim(),
          aws_secret_key: formData.aws_secret_key.trim(),
          region: formData.region || 'us-east-1',
          user_email: formData.user_email || userEmail,
          email: formData.user_email || userEmail,
          token: activeToken,
          is_admin: true,
          mode: 'admin',
        }),
      });

      const rawData = await res.json();
      const result = parseAwsValidationResponse(rawData, true, formData.region || 'us-east-1');

      if (!result.success || !result.valid_account) {
        setAwsAccessMessage(result.message);
        setAwsSecretMessage(result.message);
        setAwsValid(false);
      } else {
        setAwsAccessMessage(result.message);
        setAwsSecretMessage(result.message);
        setAwsValid(true);
        if (result.regions_summary && Array.isArray(result.regions_summary)) {
          setRegionsSummary(result.regions_summary);
        }
        setIsMultiRegionMode(Boolean(result.is_multi_region));
        const effectiveRegion = result.region || formData.region || 'us-east-1';
        setFormData((prev) => ({ ...prev, region: effectiveRegion }));
        fetchKeyPairsForRegion(effectiveRegion);

        writeAwsCredentials(formData.user_email || userEmail, {
          accessKey: formData.aws_access_key.trim(),
          secretKey: formData.aws_secret_key.trim(),
          status: 'valid',
          region: effectiveRegion,
          available_vcpus: result.available_vcpus,
          total_quota: result.total_quota,
          validatedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
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
    const email = (formData.user_email || userEmail).trim();
    if (!email || activeLabId) return;

    const storedLabId = readLabId(email);
    if (storedLabId) setActiveLabId(storedLabId);
  }, [formData.user_email, userEmail, activeLabId]);

  // -------------------------
  // Status Polling for 16 Servers
  // -------------------------
  const startPollingStatus = (labId: string, currentRegion?: string, currentEmail?: string, currentName?: string) => {
    stopAllIntervals();
    setElapsedSeconds(0);
    setLiveStatusText('Setting up your lab environment, please wait...');
    setSetupState('in_progress');

    let attempts = 0;
    const pollCheck = async () => {
      attempts++;
      try {
        const res = await fetch('/api/environment-creation/lab-status', {
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
          writeLabId(labId, currentEmail || formData.user_email || userEmail);
          const serverCount = Object.keys(servers).length;

          // Count instances with public IP assigned
          const readyWithIps = Object.values(servers).filter(
            (s: any) => s.public_ip && s.public_ip !== 'N/A'
          ).length;

          // When all 16 servers are ready with public IPs
          if (serverCount >= 16 && readyWithIps >= 16) {
            stopAllIntervals();
            setProvisionedServers(servers);
            setSetupState('completed');
            setIsSubmitting(false);
            setSuccessMessage('✅ Environment setup done! All 16 servers are ready.');
            writeLabId(labId, currentEmail || formData.user_email || userEmail);
          } else {
            setLiveStatusText('Setting up your lab environment, please wait...');
          }
        }
      } catch (err) {
        console.warn('[STATUS-POLL] Error checking status:', err);
      }

      // Safety timeout after ~4 minutes
      if (attempts >= 36) {
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
    const checkRegion = formData.region || 'us-east-1';
    if (!formData.aws_access_key || !formData.aws_secret_key || !formData.user_name.trim()) {
      setSuccessMessage('❌ Enter AWS credentials and username to check existing status');
      return;
    }

    setIsCheckingStatus(true);
    setSuccessMessage('Checking for running servers in your AWS account...');

    try {
      const emailPrefix = formData.user_email ? formData.user_email.split('@')[0] : '';
      const res = await fetch('/api/environment-creation/lab-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lab_id: activeLabId || emailPrefix,
          user_name: formData.user_name.trim(),
          user_email: formData.user_email.trim(),
          region: checkRegion,
          aws_access_key: formData.aws_access_key,
          aws_secret_key: formData.aws_secret_key,
        }),
      });

      const data = await res.json();
      if (data.success && data.instance_count > 0 && data.servers && Object.keys(data.servers).length > 0) {
        if (data.lab_id) {
          setActiveLabId(data.lab_id);
          writeLabId(data.lab_id, formData.user_email || userEmail);
        }
        const serverCount = Object.keys(data.servers).length;
        const readyWithIps = Object.values(data.servers).filter(
          (s: any) => s.public_ip && s.public_ip !== 'N/A'
        ).length;
        const targetLabId = data.lab_id || activeLabId || emailPrefix;
        if (serverCount >= 16 && readyWithIps >= 16) {
          stopAllIntervals();
          setProvisionedServers(data.servers);
          setSetupState('completed');
          setSuccessMessage(`✅ Found all ${serverCount} active servers in your account!`);
        } else {
          setProvisionedServers(null);
          setSetupState('in_progress');
          setLiveStatusText('Setting up your lab environment, please wait...');
          startPollingStatus(targetLabId, checkRegion);
        }
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

    const emailPrefix = formData.user_email ? formData.user_email.split('@')[0] : '';
    const labId = emailPrefix || formData.user_name.trim() || 'student';
    setActiveLabId(labId);
    writeLabId(labId, formData.user_email || userEmail);

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
      const res = await fetch('/api/environment-creation/submit-form', {
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




  // -------------------------------------------------------------
  // Terminate & Destroy Lab
  // -------------------------------------------------------------
  const openDestroyModal = () => {
    setDestroyConfirmChecked(false);
    setIsDestroyModalOpen(true);
  };

  const executeTerminateLab = async () => {
    if (!destroyConfirmChecked) return;
    setTerminateLoading(true);
    setTerminateMessage('Destroying all servers, Elastic IPs, and security groups in AWS... please wait.');

    try {
      const targetLabId = activeLabId || (formData.user_email ? formData.user_email.split('@')[0] : '');
      const res = await fetch('/api/environment-creation/submit-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'DESTROY',
          user_name: formData.user_name.trim() || 'student',
          user_email: formData.user_email,
          region: formData.region || 'us-east-1',
          key_pair_name: formData.key_pair_name.trim(),
          aws_access_key: formData.aws_access_key.trim(),
          aws_secret_key: formData.aws_secret_key.trim(),
          lab_id: targetLabId,
        }),
      });
      const data = await res.json();
      if (res.ok || data.success) {
        stopAllIntervals();
        setProvisionedServers(null);
        setSetupState('idle');
        setActiveLabId(null);
        removeLabId(formData.user_email || userEmail);
        setIsClusterConfigurationOpen(false);
        setIsDestroyModalOpen(false);
        setDestroyConfirmChecked(false);
        setSuccessMessage('');
        setTerminateMessage('✅ All lab servers, Elastic IPs, and security groups have been permanently destroyed and cleaned up.');
      } else {
        setTerminateMessage(`❌ Failed to terminate: ${data.message || 'Error'}`);
      }
    } catch (err: unknown) {
      setTerminateMessage(
        `❌ Error terminating lab: ${err instanceof Error ? err.message : 'Failed'}`
      );
    } finally {
      setTerminateLoading(false);
    }
  };

  // -------------------------
  // UI
  // -------------------------
  return (
    <>
      <div className="fixed right-4 top-4 z-40">
        <button
          type="button"
          onClick={() => setIsClusterConfigurationOpen(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow hover:bg-blue-700 text-xs"
        >
          Cluster Configuration
        </button>
      </div>
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

        {/* LEFT COLUMN: Configuration & Credentials (5 cols on lg) */}
        <div className="lg:col-span-5 space-y-6">

          {/* STEP 1: AWS Credentials */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-5">
        <h2 className="text-base font-bold text-gray-900 border-b border-gray-100 pb-2">
          Step 1: AWS Credentials
        </h2>
        
        <div className="space-y-4">
          <div>
            <InputField
              label="AWS Access Key"
              name="aws_access_key"
              value={formData.aws_access_key}
              onChange={handleChange}
              required
              disabled={awsValid === true || isValidating}
            />
            {awsAccessMessage && (
              <p className={`text-xs mt-1.5 font-medium ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
                {awsAccessMessage}
              </p>
            )}
          </div>

          <div>
            <InputField
              label="AWS Secret Key"
              name="aws_secret_key"
              type="password"
              value={formData.aws_secret_key}
              onChange={handleChange}
              required
              disabled={awsValid === true || isValidating}
            />
            {awsSecretMessage && (
              <p className={`text-xs mt-1.5 font-medium ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
                {awsSecretMessage}
              </p>
            )}
          </div>
        </div>

        {!awsValid && (
          <div className="flex flex-wrap gap-3 items-center pt-2">
            <button
              type="button"
              disabled={isValidating || !formData.aws_access_key || !formData.aws_secret_key}
              onClick={validateAws}
              className="flex-1 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isValidating ? 'Validating...' : 'Validate AWS'}
            </button>
            <button
              type="button"
              disabled={isCheckingStatus || !formData.aws_access_key || !formData.user_name.trim()}
              onClick={checkExistingStatus}
              className="flex-1 py-2.5 px-4 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Load your existing active servers"
            >
              {isCheckingStatus ? 'Loading...' : 'Load Dashboard'}
            </button>
          </div>
        )}
      </div>

      {/* AWS Regional Quotas Breakdown Card */}
      {awsValid && regionsSummary && regionsSummary.length > 0 && (
        <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
            <div>
              <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                <span>📊 AWS Quotas &amp; Server Allocation Plan</span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {isMultiRegionMode
                  ? '🌐 Multi-Region Allocation: All 16 servers require Elastic IPs. Allocation per region is strictly capped by available Elastic IPs.'
                  : `✅ Single-Region Capable: All 16 servers will be created in ${formData.region || 'us-east-1'} (9 Elastic IPs attached to Splunk).`}
              </p>
            </div>
            <span
              className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
                isMultiRegionMode
                  ? 'bg-purple-50 text-purple-700 border-purple-200'
                  : 'bg-green-50 text-green-700 border-green-200'
              }`}
            >
              {isMultiRegionMode ? '🌐 Multi-Region Mode (16 EIPs)' : '✅ Single Region (9 EIPs)'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
            {regionsSummary.map((r) => {
              const isSelected = r.region === formData.region;
              const hasAllocated = (r.allocated_instances ?? 0) > 0;
              return (
                <div
                  key={r.region}
                  className={`p-2.5 rounded-lg border text-xs transition ${
                    hasAllocated
                      ? 'border-blue-400 bg-blue-50/50 shadow-xs ring-1 ring-blue-200'
                      : isSelected
                      ? 'border-purple-300 bg-purple-50/40 shadow-xs'
                      : 'border-gray-200 bg-gray-50/70 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-gray-900 font-mono text-xs truncate" title={r.region}>
                      {r.region}
                    </span>
                    {isSelected && (
                      <span className="text-[9px] bg-blue-600 text-white px-1.5 py-0.2 rounded font-semibold shrink-0">
                        Primary
                      </span>
                    )}
                  </div>
                  {r.region_name && (
                    <p className="text-[10px] text-gray-500 font-medium truncate mb-1" title={r.region_name}>
                      {r.region_name}
                    </p>
                  )}

                  {/* Server Allocation Badge */}
                  <div className="mb-2">
                    {hasAllocated ? (
                      <span className="block text-center text-[10px] font-bold bg-green-100 text-green-800 border border-green-200 rounded py-0.5 px-1">
                        🖥️ {r.allocated_instances} servers ({r.allocated_eips} EIPs)
                      </span>
                    ) : (
                      <span className="block text-center text-[10px] text-gray-400 bg-gray-100 rounded py-0.5 px-1">
                        0 servers
                      </span>
                    )}
                  </div>

                  <div className="space-y-0.5 text-[11px]">
                    <div className="flex justify-between text-gray-600">
                      <span>vCPUs:</span>
                      <strong className="text-blue-700 font-mono">
                        {r.available_vcpus} <span className="text-gray-400 font-normal">/ {r.quota_vcpus}</span>
                      </strong>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>EIPs:</span>
                      <strong className="text-indigo-700 font-mono">
                        {r.available_eips} <span className="text-gray-400 font-normal">/ {r.quota_eips}</span>
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* STEP 2: Configuration & Launch (Only visible if AWS is valid) */}
      {awsValid && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-5">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <h2 className="text-base font-bold text-gray-900">
              Step 2: Configuration & Launch
            </h2>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={isCheckingStatus || !formData.aws_access_key || !formData.user_name.trim()}
                onClick={checkExistingStatus}
                className="text-xs font-semibold px-2.5 py-1 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 border border-blue-200 transition disabled:opacity-50"
              >
                {isCheckingStatus ? 'Loading...' : 'Load Dashboard'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAwsValid(null);
                  setAwsAccessMessage('');
                  setAwsSecretMessage('');
                  setRegionsSummary(null);
                  setIsMultiRegionMode(false);
                }}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                Change AWS Keys
              </button>
            </div>
          </div>
          <div className="space-y-4">

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
    <div ref={keyPairDropdownRef} className="relative w-full">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        PEM Key Name
      </label>

      <input
        type="text"
        name="key_pair_name"
        value={
          keyPairsLoading ? 'Loading key pairs…' : formData.key_pair_name
        }
        onChange={(e) => {
          handleChange(e);
          setShowDropdown(true);
          setHighlightedIndex(null);
        }}
        onKeyDown={handleKeyPairKeyDown}
        placeholder="Select or enter PEM key name"
        disabled={keyPairsLoading}
        className={`mt-1 block w-full h-[48px] rounded-md shadow-sm px-3 pr-10 text-sm border text-gray-900 ${
          keyPairsLoading
            ? 'bg-gray-100 cursor-not-allowed border-gray-300'
            : 'border-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500'
        }`}
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
          className="absolute right-2 top-12 -translate-y-1/2 text-gray-500 hover:text-gray-700 p-1"
          onClick={() => setShowDropdown(prev => !prev)}
        >
          ▼
        </button>
      )}

      {/* Dropdown list */}
      {!keyPairsLoading && showDropdown && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-auto rounded-md border border-gray-300 bg-white shadow-lg text-sm text-gray-900">
          {filteredKeyPairs.length > 0 ? (
            filteredKeyPairs.map((kp, idx) => (
              <li
                key={kp}
                className={`px-3 py-2 cursor-pointer text-sm text-gray-800 ${
                  idx === highlightedIndex ? 'bg-blue-50 text-blue-900 font-semibold' : 'hover:bg-gray-100'
                }`}
                onMouseEnter={() => setHighlightedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setFormData(prev => ({
                    ...prev,
                    key_pair_name: kp,
                  }));
                  setShowDropdown(false);
                  setHighlightedIndex(null);
                }}
              >
                {kp}
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-sm text-gray-500 italic cursor-default">
              No matching PEM keys
            </li>
          )}
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
        className={`w-full mt-4 py-3 rounded-lg text-sm font-bold text-white transition-all
          ${
            isSubmitting ||
            setupState === 'in_progress' ||
            awsValid !== true ||
            !isEmailValid ||
            !formData.user_name.trim()
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700 shadow-md hover:shadow-lg'
          }`}
      >
        {setupState === 'in_progress'
          ? 'Environment setup in progress...'
          : isSubmitting
          ? 'Starting Provisioning...'
          : '🚀 Create Environment'}
      </button>

      </div>
    </div>
  )}

        </div>
        {/* End Left Column */}

        {/* RIGHT COLUMN: Infrastructure & Status (7 cols on lg) */}
        <div className="lg:col-span-7 space-y-6">

          {/* Standby State (When idle / not provisioning and no servers yet) */}
          {setupState !== 'in_progress' && setupState !== 'completed' && (
            <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 flex flex-col items-center justify-center text-center min-h-[360px]">
              <div className="w-16 h-16 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center text-2xl text-blue-600 mb-4">
                🖥️
              </div>
              <h3 className="text-base font-bold text-gray-900">Infrastructure Dashboard</h3>
              <p className="text-xs text-gray-500 mt-1 max-w-sm">
                Validate your AWS credentials and select your configuration on the left to provision your 16 multi-region lab servers.
              </p>
              <div className="mt-6 flex flex-wrap gap-2 justify-center text-[11px] text-gray-400 font-mono">
                <span className="bg-gray-50 px-2 py-1 rounded border border-gray-100">16 Dedicated Instances</span>
                <span className="bg-gray-50 px-2 py-1 rounded border border-gray-100">Elastic Public IPs</span>
                <span className="bg-gray-50 px-2 py-1 rounded border border-gray-100">Multi-Region Balancing</span>
              </div>
            </div>
          )}

          {/* Progress Banner: Environment setup, please wait... */}
          {setupState === 'in_progress' && (
            <div className="p-6 border border-blue-200 rounded-xl bg-blue-50/70 shadow-sm w-full">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <div>
                  <h4 className="text-sm font-bold text-blue-900">
                    Setting up your lab environment, please wait...
                  </h4>
                  <p className="text-xs text-blue-700 mt-0.5">
                    {liveStatusText || 'All 16 servers will appear automatically once fully initialized.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error / Simple Info Message */}
          {successMessage && setupState !== 'in_progress' && (
            <p
              className={`text-center font-medium text-sm ${
                successMessage.startsWith('✅') ? 'text-green-600' : 'text-red-600'
              }`}
            >
              {successMessage}
            </p>
          )}

          {/* Completed Banner: Environment setup done! */}
          {setupState === 'completed' && provisionedServers && (
            <div className="p-6 border border-green-300 rounded-xl bg-green-50/50 shadow-sm w-full">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">✅</span>
                  <div>
                    <h3 className="text-sm font-bold text-green-900">
                      Environment setup done!
                    </h3>
                    <p className="text-xs text-green-700">
                      All {Object.keys(provisionedServers).length} servers are running and ready.
                    </p>
                  </div>
                </div>
                <span className="text-xs bg-green-100 text-green-800 px-2.5 py-1 rounded-full font-bold border border-green-200">
                  Active
                </span>
              </div>

              {/* Cluster Configuration Callout */}
              <div className="bg-white p-4 rounded-lg border border-green-200 mb-4 shadow-xs">
                <p className="text-xs text-gray-700 mb-2.5 font-medium">
                  👉 <strong>Next Step:</strong> Copy the server <strong>Public IPs</strong> below, then click below to configure your Splunk cluster:
                </p>
                <button
                  type="button"
                  onClick={() => setIsClusterConfigurationOpen(true)}
                  className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow flex items-center justify-center gap-2 transition-all hover:shadow-md active:scale-95"
                >
                  <span>🚀 Open Cluster Configuration</span>
                </button>
              </div>

              {/* Multi-Region Explanation Note */}
              <div className="text-[11px] text-gray-600 bg-white p-3 rounded-lg border border-gray-200 mb-4">
                💡 <em>Servers are distributed across AWS regions (e.g. <code>us-west-1</code>, <code>us-west-2</code>, <code>ap-south-1</code>) to balance vCPU limits, each with a dedicated Public Elastic IP. Select the corresponding region in your AWS Console to view them.</em>
              </div>

              {/* Server List */}
              <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
                {Object.entries(provisionedServers).map(([srvName, srvInfo]) => {
                  const pubIp =
                    typeof srvInfo === 'object' && srvInfo
                      ? srvInfo.public_ip || srvInfo.private_ip || ''
                      : String(srvInfo || '');
                  const srvRegion = typeof srvInfo === 'object' && srvInfo ? srvInfo.region : undefined;
                  return (
                    <div
                      key={srvName}
                      className="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200 text-xs shadow-xs hover:border-blue-300 transition-colors"
                    >
                      <div className="flex items-center gap-2 truncate max-w-[220px]">
                        <span className="font-semibold text-gray-800 truncate" title={srvName}>
                          {srvName}
                        </span>
                        {srvRegion && (
                          <span className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded border border-purple-200 font-mono flex-shrink-0" title={`AWS Region: ${srvRegion}`}>
                            {srvRegion}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <code className="block text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-mono text-[11px] font-medium">
                            Public: {pubIp || 'N/A'}
                          </code>
                          <code className="block text-gray-600 bg-gray-50 px-2 py-0.5 rounded font-mono text-[11px]">
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
                            className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
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

              {/* Terminate Button - ONLY under public and private IPs */}
              <div className="mt-4 pt-3 border-t border-green-200 flex justify-end">
                <button
                  type="button"
                  onClick={openDestroyModal}
                  disabled={terminateLoading}
                  className="text-xs text-red-600 hover:text-red-800 font-semibold px-4 py-2 border border-red-200 rounded-lg hover:bg-red-50 transition flex items-center gap-1.5"
                >
                  <span>🗑️</span>
                  <span>Terminate / Destroy Lab</span>
                </button>
              </div>
            </div>
          )}

          {terminateMessage && (
            <div
              className={`p-4 rounded-xl text-xs font-semibold border ${
                terminateMessage.startsWith('✅')
                  ? 'bg-green-50 border-green-200 text-green-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <p>{terminateMessage}</p>
                <button
                  type="button"
                  onClick={() => setTerminateMessage('')}
                  className="text-gray-400 hover:text-gray-600 font-bold ml-2 text-sm"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          )}

        </div>
        {/* End Right Column */}

      </div>
      {/* End Grid */}
    </form>
      {isClusterConfigurationOpen && (
        <ClusterConfigurationForm
          onClose={() => setIsClusterConfigurationOpen(false)}
          provisionedServers={provisionedServers}
          hideAuth={true}
          userEmail={formData.user_email || userEmail}
        />
      )}

      {/* Terminate & Destroy Confirmation Modal */}
      {isDestroyModalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !terminateLoading) {
              setIsDestroyModalOpen(false);
              setDestroyConfirmChecked(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-red-200"
          >
            {/* Modal Header */}
            <div className="flex items-start gap-3.5 border-b border-gray-100 pb-4">
              <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center text-red-600 text-xl font-bold shrink-0">
                ⚠️
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 leading-tight">
                  Terminate &amp; Clean Up All Lab Resources
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  This action will permanently delete all cloud resources created in your AWS account.
                </p>
              </div>
            </div>

            {/* Resource Breakdown Card */}
            <div className="mt-4 p-4 bg-red-50/70 border border-red-200 rounded-xl space-y-2.5 text-xs text-red-950">
              <p className="font-bold text-red-900 uppercase tracking-wider text-[11px]">
                Resources that will be permanently destroyed &amp; cleaned:
              </p>
              <ul className="space-y-2 pl-1">
                <li className="flex items-center gap-2.5">
                  <span className="text-base">💻</span>
                  <span><strong>All 16 EC2 Instances:</strong> 9 Splunk Cluster nodes + 7 Data Source servers</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <span className="text-base">🌐</span>
                  <span><strong>Elastic IPs:</strong> All allocated EIPs released back to AWS (prevents unwanted hourly charges)</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <span className="text-base">🛡️</span>
                  <span><strong>Security Groups:</strong> All <code>freelabs-sg-*</code> firewall groups deleted</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <span className="text-base">⚙️</span>
                  <span><strong>Cluster State:</strong> Configuration session and local storage cleared</span>
                </li>
              </ul>
            </div>

            {/* Confirmation Checkbox */}
            <div className="mt-5 p-3.5 rounded-xl border border-gray-200 bg-gray-50">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={destroyConfirmChecked}
                  onChange={(e) => setDestroyConfirmChecked(e.target.checked)}
                  disabled={terminateLoading}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-xs font-semibold text-gray-800 leading-snug">
                  I understand that all 16 servers, Elastic IPs, and configurations will be permanently destroyed, and I want to proceed.
                </span>
              </label>
            </div>

            {/* Action Buttons */}
            <div className="mt-6 flex items-center justify-end gap-3 pt-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => {
                  setIsDestroyModalOpen(false);
                  setDestroyConfirmChecked(false);
                }}
                disabled={terminateLoading}
                className="px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeTerminateLab}
                disabled={!destroyConfirmChecked || terminateLoading}
                className={`px-4 py-2 text-xs font-bold rounded-lg transition flex items-center gap-2 ${
                  !destroyConfirmChecked || terminateLoading
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-red-600 hover:bg-red-700 text-white shadow-md active:scale-95'
                }`}
              >
                {terminateLoading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Destroying Resources...</span>
                  </>
                ) : (
                  <span>🗑️ Confirm &amp; Terminate Everything</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
