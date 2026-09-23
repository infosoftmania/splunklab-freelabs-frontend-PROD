'use client';

import { useEffect, useRef, useState } from 'react';

const SERVER_NAMES = [
  'ClusterMaster',
  'Management_server',
  'SH1',
  'SH2',
  'SH3',
  'IDX1',
  'IDX2',
  'IDX3',
  'IHF',
] as const;

type ServerName = (typeof SERVER_NAMES)[number];

type Props = {
  onClose: () => void;
  provisionedServers?: Record<string, { public_ip?: string; private_ip?: string; region?: string; instance_type?: string } > | null;
};

type ProgressStep =
  | 'idle'
  | 'validating'
  | 'splunk'
  | 'license'
  | 'key'
  | 'triggering'
  | 'configuring'
  | 'completed'
  | 'failed';

const IP_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser only'));
  if ((window as unknown as { google?: { accounts?: { id?: unknown } } }).google?.accounts?.id) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Sign-In failed to load')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Sign-In failed to load'));
    document.head.appendChild(script);
  });
}

export default function ClusterConfigurationForm({ onClose, provisionedServers }: Props) {
  const [publicIps, setPublicIps] = useState<Record<ServerName, string>>(() =>
    Object.fromEntries(SERVER_NAMES.map((name) => [name, ''])) as Record<ServerName, string>
  );

  useEffect(() => {
    if (!provisionedServers) return;

    setPublicIps((prev) => {
      const updated = { ...prev };
      let hasChanges = false;
      for (const name of SERVER_NAMES) {
        const pubIp = provisionedServers[name]?.public_ip;
        if (pubIp && typeof pubIp === 'string') {
          if (updated[name] !== pubIp) {
            updated[name] = pubIp;
            hasChanges = true;
          }
        }
      }
      return hasChanges ? updated : prev;
    });
  }, [provisionedServers]);
  const [working, setWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [progressStep, setProgressStep] = useState<ProgressStep>('idle');
  const [licenseInstallReady, setLicenseInstallReady] = useState(false);

  // In-memory PEM key state (Zero-storage, never stored in S3)
  const [pemKeyContent, setPemKeyContent] = useState<string>('');
  const [pemKeyFileName, setPemKeyFileName] = useState<string>('');
  const [pemSource, setPemSource] = useState<'session' | 'uploaded' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(false);
  const [isGsiButtonRendered, setIsGsiButtonRendered] = useState(false);

  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  // Check auth state on mount via secure profile API
  useEffect(() => {
    let active = true;

    fetch('/api/auth/profile')
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (data.authenticated) {
          setIsAuthenticated(true);
          const email = data.user?.email || data.user?.email_id || '';
          setUserEmail(email);
        } else {
          setIsAuthenticated(false);
        }
      })
      .catch(() => {
        if (active) setIsAuthenticated(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = (event.target?.result as string) || '';
      if (!content.includes('-----BEGIN') || !content.includes('PRIVATE KEY-----')) {
        setErrorMessage('Invalid file format. Please select a valid private key (.pem) starting with -----BEGIN ... PRIVATE KEY-----.');
        return;
      }
      setPemKeyContent(content.trim());
      setPemKeyFileName(file.name);
      setPemSource('uploaded');
      setErrorMessage('');
    };
    reader.onerror = () => {
      setErrorMessage('Failed to read the key file. Please try again.');
    };
    reader.readAsText(file);
  };

  const handleGoogleSuccess = async (response: { credential?: string }) => {
    const idToken = response.credential;
    if (!idToken) return;

    setAuthLoading(true);
    setErrorMessage('');

    try {
      const res = await fetch('/api/auth/google-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.message || 'Google authentication failed');
      }

      setIsAuthenticated(true);
      const user = data?.user || data?.profile || data?.google_profile || data;
      const email = user?.email || user?.email_id || '';
      if (email) {
        setUserEmail(email);
      }
    } catch (err) {
      console.error('Google Sign-In error:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Google authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const startGoogleSignIn = async () => {
    setAuthLoading(true);
    setErrorMessage('');
    try {
      await loadGoogleIdentityScript();
      const clientId = GOOGLE_CLIENT_ID;
      if (!clientId) {
        throw new Error('Google Client ID (NEXT_PUBLIC_GOOGLE_CLIENT_ID) is not configured in environment.');
      }
      const google = (
        window as unknown as {
          google?: {
            accounts?: {
              id?: {
                initialize: (cfg: {
                  client_id: string;
                  callback: (resp: { credential?: string }) => void;
                }) => void;
                prompt: (cb?: (notif: { isNotDisplayed?: () => boolean; isSkippedMoment?: () => boolean }) => void) => void;
              };
            };
          };
        }
      ).google;

      if (!google?.accounts?.id) {
        throw new Error('Google Sign-In is unavailable in this browser.');
      }

      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleSuccess,
      });

      google.accounts.id.prompt();
    } catch (err) {
      console.error('Google Sign-In launch error:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Google Sign-In failed');
    } finally {
      setAuthLoading(false);
    }
  };

  // Render Google button if not authenticated
  useEffect(() => {
    if (isAuthenticated === false && GOOGLE_CLIENT_ID) {
      loadGoogleIdentityScript()
        .then(() => {
          const google = (
            window as unknown as {
              google?: {
                accounts?: {
                  id?: {
                    initialize: (cfg: {
                      client_id: string;
                      callback: (resp: { credential?: string }) => void;
                    }) => void;
                    renderButton: (
                      el: HTMLElement,
                      options: { theme?: string; size?: string; text?: string; shape?: string; width?: number },
                    ) => void;
                  };
                };
              };
            }
          ).google;

          if (google?.accounts?.id && googleBtnContainerRef.current) {
            google.accounts.id.initialize({
              client_id: GOOGLE_CLIENT_ID,
              callback: handleGoogleSuccess,
            });

            googleBtnContainerRef.current.innerHTML = '';
            google.accounts.id.renderButton(googleBtnContainerRef.current, {
              theme: 'outline',
              size: 'medium',
              text: 'signin_with',
              shape: 'rectangular',
            });
            setIsGsiButtonRendered(true);
          }
        })
        .catch((err) => console.error('Failed to load Google Sign-In:', err));
    }
  }, [isAuthenticated]);

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setIsAuthenticated(false);
    setUserEmail('');
    setIsGsiButtonRendered(false);
  };

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [working, onClose]);

  const handleIpChange = (name: ServerName, value: string) => {
    setPublicIps((prev) => ({
      ...prev,
      [name]: value.trim(),
    }));
    setLicenseInstallReady(false);
    if (progressStep === 'license') setProgressStep('idle');
    if (errorMessage) setErrorMessage('');
  };

  const closeModal = () => {
    if (!working) {
      onClose();
    }
  };

  const proceed = async () => {
    setWorking(true);
    setErrorMessage('');
    setSuccessMessage('');
    setStatusMessage('');
    setProgressStep('validating');

    try {
      // 1. Validation of all 9 IPs
      const missingServers: string[] = [];
      const invalidServers: string[] = [];
      const trimmedIps: Record<string, string> = {};

      for (const name of SERVER_NAMES) {
        const ip = (publicIps[name] || '').trim();
        trimmedIps[name] = ip;
        if (!ip) {
          missingServers.push(name);
        } else if (!IP_REGEX.test(ip)) {
          invalidServers.push(name);
        }
      }

      if (missingServers.length > 0) {
        throw new Error(`Please enter a Public IP for: ${missingServers.join(', ')}`);
      }

      if (invalidServers.length > 0) {
        throw new Error(`Invalid IP format for: ${invalidServers.join(', ')}`);
      }

      // Check for duplicates
      const seenIps = new Map<string, string>();
      for (const name of SERVER_NAMES) {
        const ip = trimmedIps[name];
        if (seenIps.has(ip)) {
          throw new Error(
            `Duplicate Public IP ${ip} entered for both "${seenIps.get(ip)}" and "${name}".`
          );
        }
        seenIps.set(ip, name);
      }

      const allPublicIps = SERVER_NAMES.map((name) => trimmedIps[name]);

      // 2. Splunk Port Validation (Port 8000)
      setProgressStep('splunk');
      setStatusMessage('Validating Splunk accessibility on port 8000...');

      const splunkResponse = await fetch('/api/lab-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/splunk-validate',
          method: 'POST',
          body: { public_ips: allPublicIps },
        }),
      });

      const splunkData = await splunkResponse.json();
      if (!splunkResponse.ok) {
        throw new Error(splunkData?.error || 'Splunk validation check failed.');
      }

      const results = Array.isArray(splunkData.results) ? splunkData.results : [];
      const downServers = results.filter((r: { status?: string }) => r.status !== 'UP');
      if (downServers.length > 0) {
        const downDetails = downServers
          .map((s: { ip?: string; details?: string }) => `${s.ip || 'Unknown IP'} (${s.details || 'DOWN'})`)
          .join(', ');
        throw new Error(`Splunk port 8000 is unreachable for: ${downDetails}`);
      }

      // 3. Pause for the user to install a valid Enterprise license in Splunk Web.
      const managementIp = trimmedIps['Management_server'];
      if (!managementIp) {
        throw new Error('Management_server Public IP is missing.');
      }

      setProgressStep('license');
      if (!licenseInstallReady) {
        setStatusMessage('Install a valid Splunk Enterprise license on Management_server, then click "Validate License & Continue".');
        setLicenseInstallReady(true);
        return;
      }

      setStatusMessage('Validating Splunk Enterprise license on Management_server...');

      const licenseResponse = await fetch('/api/lab-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/validate-splunk-license',
          method: 'POST',
          body: {
            management_server_ip: managementIp,
            username: 'admin',
            password: 'admin123',
          },
        }),
      });

      const licenseData = await licenseResponse.json().catch(() => ({}));
      if (!licenseResponse.ok || licenseData.status !== 'Splunk License updated') {
        if (licenseData?.status === 'Splunk Enterprise Trial free account') {
          throw new Error(
            'Trial license detected ("Splunk Enterprise Trial free account"). A valid Splunk Enterprise license must be installed on Management_server before cluster configuration can start. Please install your valid .lic file in Splunk Web (Settings → Licensing → Add License) and click "Validate License & Continue".'
          );
        }
        throw new Error(
          licenseData?.error || licenseData?.message ||
          'Splunk license validation failed. A valid Splunk Enterprise license is required on Management_server. Install it in Splunk Web (Settings → Licensing → Add License → Choose File → Install), then select "Validate License & Continue".'
        );
      }

      // 4. Verify EC2 Private Key (.pem)
      if (!pemKeyContent) {
        setProgressStep('key');
        throw new Error('EC2 Private Key (.pem) is required. Please upload your .pem file before continuing.');
      }

      setProgressStep('key');
      setStatusMessage('Verifying EC2 private key in memory...');

      // 5. Trigger Cluster Configuration via FreeLabs Lambda
      setProgressStep('triggering');
      setStatusMessage('Triggering Cluster Configuration via FreeLabs Lambda...');

      const planStartDate = new Date().toISOString();

      const triggerResponse = await fetch('/api/cluster-config/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userEmail ? { 'x-user-email': userEmail } : {}),
        },
        body: JSON.stringify({
          servers: trimmedIps,
          ssh_user: 'ec2-user',
          email: userEmail,
          username: userEmail ? userEmail.split('@')[0] : 'student',
          pem_key: pemKeyContent,
          splunk_username: 'admin',
          splunk_password: 'admin123',
          origin: 'freelabs',
          plan_start_date: planStartDate,
        }),
      });

      const triggerData = await triggerResponse.json().catch(() => ({}));

      if (triggerResponse.status === 401) {
        throw new Error('Authentication required. Please click "Sign in with Google" to proceed.');
      }

      if (triggerData.status === 'SPLUNK_VALIDATION_FAILED') {
        throw new Error(`Splunk port 8000 validation failed: ${triggerData.message}`);
      }

      if (triggerData.status === 'LICENSE_VALIDATION_FAILED') {
        setLicenseInstallReady(true);
        throw new Error(triggerData.message || 'Splunk Enterprise license validation failed on Management_server.');
      }

      if (!triggerResponse.ok || (triggerData.status && triggerData.status === 'error')) {
        throw new Error(triggerData?.error || triggerData?.message || 'Failed to trigger cluster configuration.');
      }

      const buildId = triggerData.build_id;

      // 6. Poll Cluster Configuration Status (1 min interval, up to 45 minutes)
      setProgressStep('configuring');
      setStatusMessage('Cluster configuration initiated. Monitoring CodeBuild execution...');

      let completed = false;
      const startTime = Date.now();
      const MAX_ATTEMPTS = 45; // 45 attempts * 60s = 45 minutes

      // Quick initial check at 15s to capture initial build phase
      await new Promise((resolve) => setTimeout(resolve, 15000));

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const elapsedMin = Math.floor(elapsedSec / 60);
        const secRemainder = elapsedSec % 60;
        const timeFormatted = elapsedMin > 0 ? `${elapsedMin}m ${secRemainder}s` : `${elapsedSec}s`;

        try {
          const statusUrl = buildId
            ? `/api/cluster-config/status?build_id=${encodeURIComponent(buildId)}`
            : `/api/cluster-config/status${userEmail ? `?email=${encodeURIComponent(userEmail)}` : ''}`;

          const clusterStatusRes = await fetch(statusUrl, {
            headers: userEmail ? { 'x-user-email': userEmail } : {},
            cache: 'no-store',
          });
          const clusterStatusData = await clusterStatusRes.json();
          if (clusterStatusRes.ok) {
            const rawStatus = (clusterStatusData.status || clusterStatusData.Status || '').toUpperCase();
            const phase = clusterStatusData.current_phase || clusterStatusData.phase || '';

            if (rawStatus) {
              setStatusMessage(
                `Cluster configuration running (${timeFormatted}) — Status: ${rawStatus} (Phase: ${phase || 'IN_PROGRESS'}). Next check in 1 min...`
              );
            }

            if (rawStatus === 'SUCCEEDED' || rawStatus === 'COMPLETED' || rawStatus === 'SUCCESS') {
              completed = true;
              break;
            }
            if (rawStatus === 'FAILED' || rawStatus === 'ERROR' || rawStatus === 'FAULT' || rawStatus === 'STOPPED') {
              throw new Error(`Cluster configuration failed with status: ${rawStatus}. Check CodeBuild logs for details.`);
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('Cluster configuration failed')) {
            throw err;
          }
        }

        if (attempt === MAX_ATTEMPTS - 1 && !completed) {
          throw new Error('Timed out waiting for cluster configuration to finish (45 minutes exceeded).');
        }

        // Wait 60s before next status API call, while updating UI clock every 5s
        for (let waitTick = 0; waitTick < 12; waitTick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const currentElapsedSec = Math.floor((Date.now() - startTime) / 1000);
          const curMin = Math.floor(currentElapsedSec / 60);
          const curSec = currentElapsedSec % 60;
          const curFormatted = curMin > 0 ? `${curMin}m ${curSec}s` : `${currentElapsedSec}s`;
          setStatusMessage((prev) => {
            if (!prev || !prev.includes('Cluster configuration running')) return prev;
            return prev.replace(/\([^)]*\)/, `(${curFormatted})`);
          });
        }
      }

      const totalElapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const totalMin = Math.floor(totalElapsedSec / 60);
      const totalSecRemainder = totalElapsedSec % 60;
      const totalTimeFormatted = totalMin > 0 ? `${totalMin}m ${totalSecRemainder}s` : `${totalElapsedSec}s`;

      setProgressStep('completed');
      setStatusMessage('');
      setSuccessMessage(`Cluster configuration completed successfully in ${totalTimeFormatted}! All 9 servers configured.`);
    } catch (error) {
      setProgressStep('failed');
      setStatusMessage('');
      setErrorMessage(error instanceof Error ? error.message : 'Cluster configuration encountered an error.');
    } finally {
      setWorking(false);
    }
  };

  const progressStepsList = [
    { label: 'IP Format & Uniqueness Validation', active: progressStep === 'validating', done: ['splunk', 'license', 'key', 'triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'Splunk Accessibility (Port 8000)', active: progressStep === 'splunk', done: ['license', 'key', 'triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'Splunk License Verification', active: progressStep === 'license', done: ['key', 'triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'EC2 Private Key (.pem) Verification', active: progressStep === 'key', done: ['triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'Triggering Cluster Setup', active: progressStep === 'triggering', done: ['configuring', 'completed'].includes(progressStep) },
    { label: 'Cluster Configuration Execution', active: progressStep === 'configuring', done: progressStep === 'completed' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cluster-config-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-200 pb-4">
          <div>
            <h2 id="cluster-config-title" className="text-xl font-bold text-gray-900">
              Cluster Configuration
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Enter the Public IPs of your 9 existing servers to proceed with cluster setup.
            </p>
          </div>
          <button
            type="button"
            onClick={closeModal}
            disabled={working}
            aria-label="Close"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-xl font-bold leading-none">&times;</span>
          </button>
        </div>

        {/* Authentication Status Bar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
              Auth Status:
            </span>
            {isAuthenticated === true ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Signed In {userEmail ? `(${userEmail})` : ''}
              </span>
            ) : isAuthenticated === false ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Google Sign-In Required
              </span>
            ) : (
              <span className="text-xs text-gray-500">Checking...</span>
            )}
          </div>

          <div>
            {isAuthenticated === true ? (
              <button
                type="button"
                onClick={handleLogout}
                disabled={working}
                className="text-xs font-medium text-gray-600 hover:text-red-600 disabled:opacity-50"
              >
                Sign out
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <div ref={googleBtnContainerRef} id="google-signin-button-container" />
                {!isGsiButtonRendered && (
                  <button
                    type="button"
                    onClick={startGoogleSignIn}
                    disabled={authLoading || working}
                    className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-xs hover:bg-gray-50 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>{authLoading ? 'Signing in...' : 'Sign in with Google'}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Server IP Inputs Table */}
        <div className="mt-5">
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-700">
                <tr>
                  <th className="px-4 py-3">Server Name</th>
                  <th className="px-4 py-3">Public IP Address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {SERVER_NAMES.map((name) => (
                  <tr key={name} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {name}
                      {name === 'Management_server' && (
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-normal text-blue-800">
                          License Master
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={publicIps[name]}
                        onChange={(e) => handleIpChange(name, e.target.value)}
                        placeholder="e.g. 54.210.10.1"
                        disabled={working}
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-xs transition-colors focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* EC2 Private Key (.pem) Upload Card */}
        <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">
                  EC2 Private Key (.pem)
                </h3>
                {pemKeyContent ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-800">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Key loaded in memory
                  </span>
                ) : (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                    Required for Ansible
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-600">
                Upload the <code className="bg-gray-200/70 px-1 py-0.5 rounded text-gray-800 font-mono text-[11px]">.pem</code> key downloaded during environment setup. Used directly in-memory and never stored in S3.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pem,.cer,.key,text/plain"
                onChange={handleFileUpload}
                disabled={working}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={working}
                className="inline-flex items-center gap-1.5 rounded-md bg-white border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-xs hover:bg-gray-50 focus:outline-hidden focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              >
                <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span>{pemKeyFileName ? 'Change .pem File' : 'Select .pem File'}</span>
              </button>
            </div>
          </div>

          {pemKeyFileName && (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-gray-700">
              <span className="font-medium text-gray-500">Selected file:</span>
              <span className="font-semibold text-gray-900 bg-white border border-gray-200 px-2 py-0.5 rounded text-[11px] font-mono">
                {pemKeyFileName}
              </span>
              {pemSource === 'session' && (
                <span className="text-[11px] text-blue-700 font-medium">
                  (Auto-detected from current session)
                </span>
              )}
            </div>
          )}
        </div>

        {licenseInstallReady && (
          <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-amber-900">Step 3: Install Splunk Enterprise License</h3>
                <p className="mt-0.5 text-xs text-amber-800">
                  Target Server: <span className="font-semibold text-gray-900">Management_server</span> ({publicIps.Management_server})
                </p>
              </div>
              <a
                href={`http://${publicIps.Management_server}:8000`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 transition-colors"
              >
                <span>Open Splunk Web</span>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </div>

            <div className="mt-3.5 rounded-md bg-white/80 p-3 border border-amber-200">
              <p className="text-xs font-semibold text-gray-800">Follow these steps in Splunk Web:</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-gray-700">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 font-semibold">Settings</span>
                <span>→</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 font-semibold">Licensing</span>
                <span>→</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 font-semibold">Add License</span>
                <span>→</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 font-semibold">Choose File</span>
                <span>→</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 font-semibold">Install</span>
              </div>
              <ol className="mt-2.5 list-decimal space-y-1 pl-4 text-xs text-gray-600">
                <li>Log in to Splunk Web on Management_server (default credentials: <code className="bg-gray-100 px-1 py-0.5 rounded text-gray-800">admin / admin123</code>).</li>
                <li>Navigate to <strong>Settings → Licensing → Add License</strong>.</li>
                <li>Select <strong>Choose File</strong>, pick your valid Splunk Enterprise <code className="bg-gray-100 px-1 py-0.5 rounded text-gray-800">.lic</code> file, and click <strong>Install</strong>.</li>
                <li>Once installed (and Splunk restarted if prompted), return here and click <strong>Validate License &amp; Continue</strong>.</li>
              </ol>
            </div>

            <p className="mt-3 text-[11px] text-amber-800 font-medium">
              Note: The license file is selected directly in your browser within Splunk Web. Free Labs does not upload or store your <code className="text-amber-900">.lic</code> file.
            </p>
          </div>
        )}

        {/* Progress Tracker (when working or finished) */}
        {(working || licenseInstallReady || progressStep === 'completed' || progressStep === 'failed') && (
          <div className="mt-5 rounded-lg border border-blue-100 bg-blue-50/70 p-4">
            <h3 className="text-sm font-semibold text-blue-900">Configuration Progress</h3>
            <ul className="mt-2.5 space-y-1.5 text-xs sm:text-sm">
              {progressStepsList.map((step) => (
                <li key={step.label} className="flex items-center gap-2">
                  {step.done ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-xs font-bold text-green-700">
                      ✓
                    </span>
                  ) : step.active ? (
                    <span className="flex h-5 w-5 items-center justify-center">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                    </span>
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center text-gray-400">
                      ○
                    </span>
                  )}
                  <span
                    className={
                      step.done
                        ? 'font-medium text-green-800'
                        : step.active
                        ? 'font-semibold text-blue-800'
                        : 'text-gray-500'
                    }
                  >
                    {step.label}
                  </span>
                </li>
              ))}
            </ul>
            {statusMessage && (
              <p className="mt-2.5 text-xs text-blue-700 font-medium animate-pulse">
                {statusMessage}
              </p>
            )}
          </div>
        )}

        {/* Error Alert */}
        {errorMessage && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm text-red-700">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Error:</span>
              <span>{errorMessage}</span>
            </div>
          </div>
        )}

        {/* Success Alert */}
        {successMessage && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3.5 text-sm text-green-700">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Success:</span>
              <span>{successMessage}</span>
            </div>
          </div>
        )}

        {/* Action Button */}
        <div className="mt-6 flex justify-end gap-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={closeModal}
            disabled={working}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {progressStep === 'completed' ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={proceed}
            disabled={working || progressStep === 'completed'}
            className={`rounded-lg px-5 py-2 text-sm font-semibold text-white shadow-xs transition-colors ${
              working || progressStep === 'completed'
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {working
              ? 'Processing...'
              : licenseInstallReady
              ? 'Validate License & Continue'
              : !pemKeyContent
              ? 'Select .pem Key & Continue'
              : 'Validate Servers & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
