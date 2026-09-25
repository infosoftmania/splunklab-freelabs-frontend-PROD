export type StoredLabServer = {
  public_ip?: string;
  private_ip?: string;
  instance_id?: string;
  state?: string;
  instance_type?: string;
  region?: string;
};

export type StoredAwsCredentials = {
  accessKey: string;
  secretKey: string;
  status?: 'valid' | 'insufficient_vcpu';
  region?: string;
  available_vcpus?: number;
  total_quota?: number;
  permission_denied?: boolean;
  message?: string;
  account_id?: string;
  validatedAt?: string;
  updatedAt: string;
};

const LAB_ID_STORAGE_KEY = 'labId';
const getLabIdStorageKey = (email: string) => `freelabs:labId:${email.trim().toLowerCase()}`;
const getLegacyLabStorageKey = (email: string) => `freelabs:lab:${email.trim().toLowerCase()}`;
const getAwsVerificationStorageKey = (email: string) =>
  `freelabs:aws-verification:${email.trim().toLowerCase()}`;
const getAwsCredentialsStorageKey = (email: string) =>
  `freelabs:aws-credentials:${email.trim().toLowerCase()}`;

export function readLabId(email?: string): string | null {
  if (typeof window === 'undefined') return null;

  try {
    if (email && email.trim()) {
      window.localStorage.removeItem(LAB_ID_STORAGE_KEY);
      const userScoped = window.localStorage.getItem(getLabIdStorageKey(email));
      if (userScoped) return userScoped;
      return null;
    }
    return window.localStorage.getItem(LAB_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeLabId(labId: string, email?: string) {
  if (typeof window === 'undefined' || !labId.trim()) return;

  try {
    if (email && email.trim()) {
      window.localStorage.setItem(getLabIdStorageKey(email), labId.trim());
      // Clean up stale global un-scoped key
      window.localStorage.removeItem(LAB_ID_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LAB_ID_STORAGE_KEY, labId.trim());
    }
  } catch {
  }
}

export function removeLabId(email?: string) {
  if (typeof window === 'undefined') return;

  try {
    if (email && email.trim()) {
      window.localStorage.removeItem(getLabIdStorageKey(email));
    }
    window.localStorage.removeItem(LAB_ID_STORAGE_KEY);
  } catch {
  }
}

export function removeLegacyLabSnapshot(email: string) {
  if (typeof window === 'undefined' || !email.trim()) return;

  try {
    window.localStorage.removeItem(getLegacyLabStorageKey(email));
  } catch {
  }
}

export function removeAwsVerification(email: string) {
  if (typeof window === 'undefined' || !email.trim()) return;

  try {
    window.localStorage.removeItem(getAwsVerificationStorageKey(email));
  } catch {
  }
}

export function readAwsCredentials(email: string): StoredAwsCredentials | null {
  if (typeof window === 'undefined' || !email.trim()) return null;

  try {
    const value = window.localStorage.getItem(getAwsCredentialsStorageKey(email));
    return value ? (JSON.parse(value) as StoredAwsCredentials) : null;
  } catch {
    return null;
  }
}

export function writeAwsCredentials(email: string, credentials: StoredAwsCredentials) {
  if (typeof window === 'undefined' || !email.trim()) return;

  try {
    window.localStorage.setItem(getAwsCredentialsStorageKey(email), JSON.stringify(credentials));
  } catch {
  }
}

export function removeAwsCredentials(email: string) {
  if (typeof window === 'undefined' || !email.trim()) return;

  try {
    window.localStorage.removeItem(getAwsCredentialsStorageKey(email));
  } catch {
  }
}
