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
};

type ProgressStep =
  | 'idle'
  | 'validating'
  | 'splunk'
  | 'license'
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

export default function ClusterConfigurationForm({ onClose }: Props) {
  const [publicIps, setPublicIps] = useState<Record<ServerName, string>>(() =>
    Object.fromEntries(SERVER_NAMES.map((name) => [name, ''])) as Record<ServerName, string>
  );
  const [working, setWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [progressStep, setProgressStep] = useState<ProgressStep>('idle');
  const [licenseInstallReady, setLicenseInstallReady] = useState(false);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(false);
  const [isGsiButtonRendered, setIsGsiButtonRendered] = useState(false);

  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  // Check auth state on mount
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
      const user = data?.user || data?.profile || data;
      const email = user?.email || user?.email_id || '';
      setUserEmail(email);
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

      // 4. Resolve Public IPs → EC2 InstanceIds
      setProgressStep('triggering');
      setStatusMessage('Resolving EC2 instance IDs...');

      const resolveResponse = await fetch('/api/ec2/resolve-instance-ids', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userEmail ? { 'x-user-email': userEmail } : {}),
        },
        body: JSON.stringify({
          publicIps: allPublicIps,
          email: userEmail,
        }),
      });

      const resolveData = await resolveResponse.json();

      if (resolveResponse.status === 401) {
        setIsAuthenticated(false);
        throw new Error('Authentication required. Please sign in with Google to proceed.');
      }

      if (!resolveResponse.ok) {
        throw new Error(
          resolveData?.error || 'Failed to resolve EC2 instance IDs from the backend.',
        );
      }

      const mapping: Record<string, string> = resolveData?.mapping || {};
      const unresolved: string[] = resolveData?.unresolved || [];

      if (unresolved.length > 0) {
        throw new Error(
          `Could not find EC2 InstanceId for the following Public IP${unresolved.length > 1 ? 's' : ''}: ` +
            unresolved.join(', ') +
            '. Ensure these instances exist and are visible to the configured AWS account.',
        );
      }

      // Build the ordered list of InstanceIds matching SERVER_NAMES order
      const instanceIds = allPublicIps.map((ip) => mapping[ip]);

      // 5. Trigger Cluster Configuration
      setStatusMessage('Triggering Cluster Configuration...');

      const triggerResponse = await fetch('/api/cluster-config/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userEmail ? { 'x-user-email': userEmail } : {}),
        },
        body: JSON.stringify({
          instances: instanceIds,
          ssh_user: 'ec2-user',
        }),
      });

      const triggerData = await triggerResponse.json();

      if (triggerResponse.status === 401) {
        setIsAuthenticated(false);
        throw new Error('Authentication required. Please click "Sign in with Google" to proceed.');
      }

      if (!triggerResponse.ok || (triggerData.status && triggerData.status === 'error')) {
        throw new Error(triggerData?.error || triggerData?.message || 'Failed to trigger cluster configuration.');
      }

      // 5. Poll Cluster Configuration Status
      setProgressStep('configuring');
      setStatusMessage('Cluster configuration in progress. Waiting for completion...');

      let completed = false;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Check cluster-config status
        try {
          const clusterStatusRes = await fetch(
            `/api/cluster-config/status${userEmail ? `?email=${encodeURIComponent(userEmail)}` : ''}`,
            {
              headers: userEmail ? { 'x-user-email': userEmail } : {},
              cache: 'no-store',
            },
          );
          const clusterStatusData = await clusterStatusRes.json();
          if (clusterStatusRes.ok) {
            const records = Array.isArray(clusterStatusData)
              ? clusterStatusData
              : clusterStatusData?.records || [];

            const isDone = records.some((record: { status?: string; Status?: string }) => {
              const st = (record.status || record.Status || '').toLowerCase();
              return st === 'completed' || st === 'success' || st === 'succeeded';
            });
            if (isDone) {
              completed = true;
              break;
            }

            const isFailed = records.some((record: { status?: string; Status?: string }) => {
              const st = (record.status || record.Status || '').toLowerCase();
              return st === 'failed' || st === 'error';
            });
            if (isFailed) {
              throw new Error('Cluster configuration provisioning failed.');
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('provisioning failed')) {
            throw err;
          }
        }

        // Check pro-status fallback
        try {
          const proStatusRes = await fetch(
            `/api/pro-status${userEmail ? `?email=${encodeURIComponent(userEmail)}` : ''}`,
            {
              headers: userEmail ? { 'x-user-email': userEmail } : {},
              cache: 'no-store',
            },
          );
          const proStatusData = await proStatusRes.json();
          if (proStatusRes.ok) {
            const records = Array.isArray(proStatusData)
              ? proStatusData
              : proStatusData?.records || [];

            const isDone = records.some((record: { status?: string; Status?: string }) => {
              const st = (record.status || record.Status || '').toLowerCase();
              return st === 'completed' || st === 'success' || st === 'succeeded';
            });
            if (isDone) {
              completed = true;
              break;
            }

            const isFailed = records.some((record: { status?: string; Status?: string }) => {
              const st = (record.status || record.Status || '').toLowerCase();
              return st === 'failed' || st === 'error';
            });
            if (isFailed) {
              throw new Error('Cluster configuration provisioning failed.');
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('provisioning failed')) {
            throw err;
          }
        }

        if (attempt === 44 && !completed) {
          throw new Error('Timed out waiting for cluster configuration to finish.');
        }
      }

      setProgressStep('completed');
      setStatusMessage('');
      setSuccessMessage('Cluster configuration completed successfully!');
    } catch (error) {
      setProgressStep('failed');
      setStatusMessage('');
      setErrorMessage(error instanceof Error ? error.message : 'Cluster configuration encountered an error.');
    } finally {
      setWorking(false);
    }
  };

  const progressStepsList = [
    { label: 'IP Format & Uniqueness Validation', active: progressStep === 'validating', done: ['splunk', 'license', 'triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'Splunk Accessibility (Port 8000)', active: progressStep === 'splunk', done: ['license', 'triggering', 'configuring', 'completed'].includes(progressStep) },
    { label: 'Splunk License Verification', active: progressStep === 'license', done: ['triggering', 'configuring', 'completed'].includes(progressStep) },
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
              : 'Validate Servers & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
