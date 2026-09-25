/**
 * Shared AWS Credential & Quota Validation Utilities
 */

export const REQUIRED_VCPUS = 36;
export const REQUIRED_SPLUNK_EIPS = 9;
export const DEFAULT_REGION = 'us-east-1';

export type CredValidationStatus =
  | 'idle'
  | 'valid'
  | 'invalid_account'
  | 'insufficient_vcpu'
  | 'insufficient_eip';

export type ParsedAwsValidationResult = {
  success: boolean;
  valid_account: boolean;
  has_required_vcpu: boolean;
  has_required_eips: boolean;
  available_vcpus: number;
  available_vcpu: number;
  required_vcpus: number;
  required_vcpu: number;
  available_eips: number;
  required_eips: number;
  total_quota: number;
  total_eip_quota: number;
  region: string;
  account_id?: string;
  arn?: string;
  email?: string;
  is_admin?: boolean;
  admin_override?: boolean;
  mode?: string;
  service?: string;
  message: string;
  status: CredValidationStatus;
  permission_denied?: boolean;
  regions_summary?: any[];
  is_multi_region?: boolean;
  [key: string]: any;
};

/**
 * Extracts email from a standard JWT token.
 */
export function extractEmailFromToken(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    const decoded = JSON.parse(jsonStr);
    return decoded.email || decoded.email_id || '';
  } catch {
    return '';
  }
}

/**
 * Safely decodes JWT payload object.
 */
export function decodeJwtPayload(token?: string): Record<string, any> {
  if (!token || typeof token !== 'string' || !token.includes('.')) return {};
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

/**
 * Formats a validation timestamp into user-friendly locale string.
 */
export function formatVerificationTime(validatedAt?: string): string {
  if (!validatedAt) return '';
  const parsedDate = new Date(validatedAt);
  if (Number.isNaN(parsedDate.getTime())) return '';
  return parsedDate.toLocaleString();
}

/**
 * Builds user-facing badge summary for verified accounts.
 */
export function buildVerificationBadge(
  availableVcpus: number | undefined,
  region: string,
  validatedAt?: string,
  hasAwsCredentials = true
): string {
  const verifiedTime = formatVerificationTime(validatedAt);
  const timeText = verifiedTime ? ` Last verified ${verifiedTime}.` : '';
  const credentialText = hasAwsCredentials ? ' Ready to configure.' : ' Re-enter AWS keys to continue.';
  return `AWS Account Verified! Found ${availableVcpus ?? REQUIRED_VCPUS} vCPUs in ${region}.${credentialText}${timeText}`;
}

/**
 * Normalizes responses from the upstream validation API and internal route.
 * Guarantees consistent properties across all API and frontend callers.
 */
export function normalizeAwsValidationResponse(
  data: any,
  isAdmin?: boolean,
  fallbackRegion = DEFAULT_REGION
): ParsedAwsValidationResult {
  const raw = data && typeof data === 'object' ? data : {};

  const availableVcpus = Number(raw.available_vcpus ?? raw.available_vcpu ?? 0);
  const requiredVcpus = Number(raw.required_vcpus ?? raw.required_vcpu ?? REQUIRED_VCPUS);
  const hasRequiredVcpu = availableVcpus >= requiredVcpus;

  const availableEips = Number(raw.available_eips ?? raw.elastic_ip_count ?? raw.eip_quota ?? 0);
  const requiredEips = Number(raw.required_eips ?? REQUIRED_SPLUNK_EIPS);
  const hasRequiredEips = availableEips >= requiredEips;

  // Account is valid if success is true, or account_id/arn is present, or quota numbers were returned
  const hasQuotaData =
    raw.available_vcpus !== undefined ||
    raw.available_vcpu !== undefined ||
    raw.available_eips !== undefined ||
    raw.elastic_ip_count !== undefined ||
    raw.eip_quota !== undefined;

  const isValidAccount =
    raw.valid_account !== undefined
      ? Boolean(raw.valid_account)
      : Boolean(raw.success === true || hasQuotaData || raw.account_id || raw.arn);

  const effectiveAdmin = Boolean(
    isAdmin !== undefined ? isAdmin : raw.is_admin === true || raw.mode === 'admin'
  );

  // If user is an Admin and credentials are valid, allow overriding quota checks to proceed to Step 2
  const adminOverride = Boolean(
    effectiveAdmin && isValidAccount && (!hasRequiredVcpu || !hasRequiredEips)
  );

  const isSuccess = Boolean(
    raw.success === true ||
    (isValidAccount && hasRequiredVcpu && hasRequiredEips && raw.success !== false) ||
    adminOverride
  );

  let status: CredValidationStatus = 'valid';
  let message = raw.message || '';

  if (!isValidAccount) {
    status = 'invalid_account';
    message = message || 'Invalid AWS Credentials. Account not found or inactive.';
  } else if (!hasRequiredVcpu && !adminOverride) {
    status = 'insufficient_vcpu';
    message =
      message ||
      `Insufficient vCPU Quota: Found ${availableVcpus} vCPUs in ${raw.region || fallbackRegion}. At least ${requiredVcpus} vCPUs are required.`;
  } else if (!hasRequiredEips && !adminOverride) {
    status = 'insufficient_eip';
    message =
      message ||
      `Insufficient Elastic IP Quota: Found ${availableEips} Elastic IPs in ${raw.region || fallbackRegion}. At least ${requiredEips} Elastic IPs are required.`;
  } else {
    status = 'valid';
    if (adminOverride) {
      message = raw.message
        ? `⚠️ ${raw.message} (Admin override: Proceeding to Step 2)`
        : `⚠️ Admin override active: Found ${availableVcpus} vCPUs and ${availableEips} Elastic IPs. Proceeding to Step 2.`;
    } else {
      message = message || 'AWS credentials, vCPU quota, and Elastic IP quota validation successful';
    }
  }

  return {
    ...raw,
    success: isSuccess,
    valid_account: isValidAccount,
    admin_override: adminOverride,
    has_required_vcpu: hasRequiredVcpu,
    has_required_eips: hasRequiredEips,
    available_vcpus: availableVcpus,
    available_vcpu: availableVcpus,
    required_vcpus: requiredVcpus,
    required_vcpu: requiredVcpus,
    available_eips: availableEips,
    required_eips: requiredEips,
    total_quota: raw.total_quota ?? availableVcpus,
    total_eip_quota: raw.total_eip_quota ?? raw.eip_quota ?? availableEips,
    region: raw.region || fallbackRegion,
    is_admin: effectiveAdmin,
    mode: effectiveAdmin ? 'admin' : (raw.mode || 'student'),
    status,
    message,
  };
}

export const parseAwsValidationResponse = normalizeAwsValidationResponse;
