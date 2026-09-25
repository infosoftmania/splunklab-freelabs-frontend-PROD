import { NextRequest, NextResponse } from 'next/server';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { EC2Client, DescribeInstancesCommand, DescribeAddressesCommand } from '@aws-sdk/client-ec2';

export const dynamic = 'force-dynamic';

const AWS_CRED_VALIDATE_API_URL =
  process.env.AWS_CRED_VALIDATE_API_URL ||
  'https://u8eyhd99pc.execute-api.us-east-1.amazonaws.com/validate-aws-cred';

const REQUIRED_VCPUS = 36;
const STANDARD_VCPU_QUOTA_CODE = 'L-1216C47A'; // Running On-Demand Standard instances
const REQUIRED_SPLUNK_EIPS = 9; // In single-region, 9 splunk servers need Elastic IPs
const REQUIRED_MULTI_REGION_EIPS = 16; // In multi-region, ALL 16 servers need Elastic IPs
const ELASTIC_IP_QUOTA_CODE = 'L-0263D0A3'; // EC2-VPC Elastic IPs (default: 5)
const TOTAL_SERVERS_COUNT = 16;

function extractEmailFromToken(token: string): string {
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

function decodeJwtPayload(t?: string): Record<string, any> {
  if (!t || typeof t !== 'string' || !t.includes('.')) return {};
  try {
    const parts = t.split('.');
    if (parts.length < 2) return {};
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

function isBackendAccessToken(t?: string): boolean {
  if (!t || typeof t !== 'string' || !t.includes('.')) return false;
  try {
    const payload = decodeJwtPayload(t);
    if (!payload || (!payload.iss && !payload.aud && !payload.sub)) return false;

    // Check expiration if present
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return false; // Expired!
    }

    // Google ID tokens have accounts.google.com as issuer
    if (payload.iss && String(payload.iss).includes('accounts.google.com')) {
      return false;
    }

    // Backend tokens have my-auth-jwks issuer or my-api audience
    if (String(payload.iss || '').includes('my-auth-jwks') || payload.aud === 'my-api') {
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

function resolveBackendToken(req: NextRequest, bodyToken?: string): string {
  const cookieAccessToken =
    req.cookies.get('access_token')?.value ||
    req.cookies.get('token')?.value;

  const rawAuth = req.headers.get('authorization') || req.headers.get('token') || '';
  const headerToken = rawAuth.replace(/^Bearer\s+/i, '').trim();

  // 1. Prioritize a valid, unexpired backend token from cookie first (server-managed and refreshed)
  if (isBackendAccessToken(cookieAccessToken)) return cookieAccessToken!;

  // 2. If explicit body/header token is a valid unexpired backend token, use it
  if (isBackendAccessToken(bodyToken)) return bodyToken!;
  if (isBackendAccessToken(headerToken)) return headerToken;

  // 3. Fallback to cookie access_token if present
  if (cookieAccessToken) return cookieAccessToken;

  // 4. Fallback to any token provided
  return bodyToken || headerToken || req.cookies.get('google_token')?.value || '';
}

async function checkRegionQuota(
  regionName: string,
  key: string,
  secret: string
): Promise<{ region: string; quota: number; used: number; available: number }> {
  let quotaValue = 0;
  let usedVcpus = 0;

  try {
    const sqClient = new ServiceQuotasClient({
      region: regionName,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });

    const quotaRes = await sqClient.send(
      new GetServiceQuotaCommand({
        ServiceCode: 'ec2',
        QuotaCode: STANDARD_VCPU_QUOTA_CODE,
      })
    );
    quotaValue = Number(quotaRes.Quota?.Value ?? 0);
  } catch {
    quotaValue = 0;
  }

  try {
    const ec2Client = new EC2Client({
      region: regionName,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });

    const instancesRes = await ec2Client.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: 'instance-state-name', Values: ['running', 'pending'] }],
      })
    );

    for (const res of instancesRes.Reservations || []) {
      for (const inst of res.Instances || []) {
        const itype = inst.InstanceType || '';
        if (itype.includes('xlarge')) usedVcpus += 4;
        else if (itype.includes('large') || itype.includes('medium')) usedVcpus += 2;
        else usedVcpus += 1;
      }
    }
  } catch {}

  const available = Math.max(0, quotaValue - usedVcpus);
  return { region: regionName, quota: quotaValue, used: usedVcpus, available };
}

async function checkRegionElasticIpQuota(
  regionName: string,
  key: string,
  secret: string
): Promise<{ region: string; quota: number; used: number; available: number }> {
  let quotaValue = 5;
  let usedEips = 0;

  try {
    const sqClient = new ServiceQuotasClient({
      region: regionName,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });

    const quotaRes = await sqClient.send(
      new GetServiceQuotaCommand({
        ServiceCode: 'ec2',
        QuotaCode: ELASTIC_IP_QUOTA_CODE,
      })
    );
    quotaValue = Number(quotaRes.Quota?.Value ?? 5);
  } catch {
    quotaValue = 5;
  }

  try {
    const ec2Client = new EC2Client({
      region: regionName,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });

    const eipRes = await ec2Client.send(new DescribeAddressesCommand({}));
    usedEips = eipRes.Addresses?.length ?? 0;
  } catch {}

  const available = Math.max(0, quotaValue - usedEips);
  return { region: regionName, quota: quotaValue, used: usedEips, available };
}

async function callUpstreamLogLambda(params: {
  trimmedKey: string;
  trimmedSecret: string;
  cleanToken: string;
  userEmail: string;
  targetRegion: string;
  isAdmin: boolean;
  mode: string;
  accountId: string;
  availableVcpus: number;
  quotaVcpus: number;
  usedVcpus: number;
  availableEips: number;
  quotaEips: number;
  usedEips: number;
  hasRequiredVcpu: boolean;
  hasRequiredEips: boolean;
  isValidAccount: boolean;
  isSuccess: boolean;
  regionsSummary?: any[];
  allocationPlan?: any[];
  failureReason?: string;
}): Promise<boolean> {
  try {
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (params.cleanToken) {
      upstreamHeaders['Authorization'] = `Bearer ${params.cleanToken}`;
      upstreamHeaders['token'] = params.cleanToken;
    }

    const payload = {
      // Credential variants for compatibility with various Lambda parsers / boto3
      aws_access_key: params.trimmedKey,
      aws_secret_key: params.trimmedSecret,
      aws_access_key_id: params.trimmedKey,
      aws_secret_access_key: params.trimmedSecret,
      access_key: params.trimmedKey,
      secret_key: params.trimmedSecret,
      access_key_id: params.trimmedKey,
      secret_access_key: params.trimmedSecret,
      AccessKeyId: params.trimmedKey,
      SecretAccessKey: params.trimmedSecret,

      // Token and auth
      token: params.cleanToken,
      user_email: params.userEmail,
      email: params.userEmail,
      is_admin: params.isAdmin,
      mode: params.isAdmin ? 'admin' : (params.mode || 'student'),

      // Account & Region
      account_id: params.accountId,
      accountId: params.accountId,
      region: params.targetRegion,
      reion: params.targetRegion,
      target_region: params.targetRegion,

      // vCPU Quotas
      available_vcpus: params.availableVcpus,
      available_vcpu: params.availableVcpus,
      quota_vcpus: params.quotaVcpus,
      total_quota: params.quotaVcpus,
      total_vcpus: params.quotaVcpus,
      used_vcpus: params.usedVcpus,
      required_vcpu: REQUIRED_VCPUS,
      required_vcpus: REQUIRED_VCPUS,

      // Elastic IP Quotas (pass all aliases: available_eips, total_eip_quota, eip_quota, elastic_ip_quota)
      available_eips: params.availableEips,
      available_eip: params.availableEips,
      total_eip_quota: params.quotaEips,
      total_eips: params.quotaEips,
      quota_eips: params.quotaEips,
      eip_quota: params.quotaEips,
      elastic_ip_quota: params.quotaEips,
      used_eips: params.usedEips,
      elastic_ip_count: params.usedEips,
      elastic_ips: params.availableEips,
      required_eips: REQUIRED_SPLUNK_EIPS,

      // Status & Results
      valid_account: params.isValidAccount,
      has_required_vcpu: params.hasRequiredVcpu,
      has_required_eips: params.hasRequiredEips,
      success: params.isSuccess,
      status: params.isSuccess ? 'SUCCESS' : 'FAILED',
      failure_reason: params.failureReason || '',

      // Multi-region breakdown
      regions_summary: params.regionsSummary || [],
      allocation_plan: params.allocationPlan || [],
      timestamp: new Date().toISOString(),
    };

    console.log(
      `[VALIDATE-AWS-CRED] Calling log lambda at ${AWS_CRED_VALIDATE_API_URL} (account: ${params.accountId || 'none'}, region: ${params.targetRegion}, vCPUs: ${params.availableVcpus}/${params.quotaVcpus}, EIPs: ${params.availableEips}/${params.quotaEips}, success: ${params.isSuccess})`
    );

    const upstreamResp = await fetch(AWS_CRED_VALIDATE_API_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload),
    });

    const upstreamText = await upstreamResp.text();
    console.log(`[VALIDATE-AWS-CRED] Upstream log lambda response [${upstreamResp.status}]:`, upstreamText);
    return upstreamResp.ok;
  } catch (logErr) {
    console.warn('[VALIDATE-AWS-CRED] Upstream logging failed:', logErr);
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { aws_access_key, aws_secret_key, region = 'us-east-1', is_admin, mode } = body;
    const isAdmin = Boolean(is_admin === true || mode === 'admin');

    // 1. Basic validation
    if (!aws_access_key || !aws_secret_key) {
      return NextResponse.json(
        {
          success: false,
          valid_account: false,
          has_required_vcpu: false,
          available_vcpus: 0,
          message: 'AWS Access Key and Secret Key are required.',
        },
        { status: 400 }
      );
    }

    const trimmedKey = String(aws_access_key).trim();
    const trimmedSecret = String(aws_secret_key).trim();
    const targetRegion = region || 'us-east-1';

    // Extract token & resolve user email
    const activeToken = resolveBackendToken(req, body?.token || body?.access_token);
    const cleanToken = (activeToken || '').replace(/^Bearer\s+/i, '').trim();

    let userEmail = body?.user_email || body?.email || '';
    if (!userEmail && activeToken) {
      userEmail = extractEmailFromToken(activeToken);
    }

    let upstreamLogged = false;

    // 3. Authenticate credentials with AWS STS
    let accountId = '';
    const stsClient = new STSClient({
      region: targetRegion,
      credentials: {
        accessKeyId: trimmedKey,
        secretAccessKey: trimmedSecret,
      },
    });

    try {
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account || '';
    } catch (stsErr: any) {
      console.warn('[VALIDATE-AWS-CRED] STS verification failed:', stsErr?.message);
      await callUpstreamLogLambda({
        trimmedKey,
        trimmedSecret,
        cleanToken,
        userEmail,
        targetRegion,
        isAdmin,
        mode: isAdmin ? 'admin' : (mode || 'student'),
        accountId: '',
        availableVcpus: 0,
        quotaVcpus: 0,
        usedVcpus: 0,
        availableEips: 0,
        quotaEips: 0,
        usedEips: 0,
        hasRequiredVcpu: false,
        hasRequiredEips: false,
        isValidAccount: false,
        isSuccess: false,
        failureReason: 'Invalid AWS Credentials. Account not found or credentials inactive.',
      });
      return NextResponse.json(
        {
          success: false,
          valid_account: false,
          has_required_vcpu: false,
          available_vcpus: 0,
          region: targetRegion,
          email: userEmail,
          message: 'Invalid AWS Credentials. Account not found or credentials inactive.',
        },
        { status: 200 }
      );
    }

    // 4. Check vCPU & Elastic IP quotas across the 10 requested AWS regions
    const AWS_TARGET_REGIONS = [
      { id: 'us-east-1', name: 'N. Virginia' },
      { id: 'us-east-2', name: 'Ohio' },
      { id: 'us-west-1', name: 'N. California' },
      { id: 'us-west-2', name: 'Oregon' },
      { id: 'ap-south-1', name: 'Mumbai' },
      { id: 'ap-northeast-3', name: 'Osaka' },
      { id: 'ap-northeast-2', name: 'Seoul' },
      { id: 'ap-southeast-1', name: 'Singapore' },
      { id: 'ap-southeast-2', name: 'Sydney' },
      { id: 'ap-northeast-1', name: 'Tokyo' },
    ];

    const regionsToCheck = [
      ...AWS_TARGET_REGIONS.filter((r) => r.id === targetRegion),
      ...AWS_TARGET_REGIONS.filter((r) => r.id !== targetRegion),
    ];

    const regionChecks = await Promise.all(
      regionsToCheck.map(async ({ id: reg, name: regName }) => {
        const [vcpu, eip] = await Promise.all([
          checkRegionQuota(reg, trimmedKey, trimmedSecret),
          checkRegionElasticIpQuota(reg, trimmedKey, trimmedSecret),
        ]);
        return {
          region: reg,
          region_name: regName,
          available_vcpus: vcpu.available,
          quota_vcpus: vcpu.quota,
          used_vcpus: vcpu.used,
          available_eips: eip.available,
          quota_eips: eip.quota,
          used_eips: eip.used,
        };
      })
    );

    // 5. Check Single-Region Qualification
    // If a single region has >= 36 vCPUs and >= 9 Elastic IPs -> Single-Region capable (9 EIPs for Splunk nodes)
    const singleRegionQualified = regionChecks.find(
      (r) => r.available_vcpus >= REQUIRED_VCPUS && r.available_eips >= REQUIRED_SPLUNK_EIPS
    );
    const isMultiRegion = !singleRegionQualified;

    // 6. Calculate Allocation Plan:
    // - Single-Region: All 16 instances in 1 region, 9 Elastic IPs attached to Splunk
    // - Multi-Region: 16 instances distributed across regions strictly capped by each region's available Elastic IPs
    let allocationPlan: Array<{
      region: string;
      region_name: string;
      allocated_instances: number;
      allocated_eips: number;
      available_vcpus: number;
      quota_vcpus: number;
      used_vcpus: number;
      available_eips: number;
      quota_eips: number;
      used_eips: number;
    }> = [];

    if (!isMultiRegion && singleRegionQualified) {
      allocationPlan = regionChecks.map((r) => ({
        ...r,
        allocated_instances: r.region === singleRegionQualified.region ? TOTAL_SERVERS_COUNT : 0,
        allocated_eips: r.region === singleRegionQualified.region ? REQUIRED_SPLUNK_EIPS : 0,
      }));
    } else {
      let remaining = TOTAL_SERVERS_COUNT;
      const sortedRegions = [...regionChecks].sort((a, b) => {
        if (a.region === targetRegion) return -1;
        if (b.region === targetRegion) return 1;
        return b.available_eips - a.available_eips;
      });

      const allocMap: Record<string, { instances: number; eips: number }> = {};
      for (const r of sortedRegions) {
        if (remaining <= 0) {
          allocMap[r.region] = { instances: 0, eips: 0 };
          continue;
        }
        // Base allocation strictly on Elastic IP count (e.g. 5 EIPs -> max 5 instances)
        const maxInstances = Math.min(remaining, Math.max(0, r.available_eips));
        allocMap[r.region] = { instances: maxInstances, eips: maxInstances };
        remaining -= maxInstances;
      }

      allocationPlan = regionChecks.map((r) => ({
        ...r,
        allocated_instances: allocMap[r.region]?.instances ?? 0,
        allocated_eips: allocMap[r.region]?.eips ?? 0,
      }));
    }

    const totalAllocatedInstances = allocationPlan.reduce((sum, r) => sum + r.allocated_instances, 0);
    const totalAllocatedEips = allocationPlan.reduce((sum, r) => sum + r.allocated_eips, 0);
    const totalAvailableVcpus = regionChecks.reduce((sum, r) => sum + r.available_vcpus, 0);
    const totalAvailableEips = regionChecks.reduce((sum, r) => sum + r.available_eips, 0);
    const singleRegionVcpu = regionChecks.find((r) => r.available_vcpus >= REQUIRED_VCPUS);
    const highestVcpu = regionChecks.reduce((best, curr) =>
      curr.available_vcpus > best.available_vcpus ? curr : best
    );

    // 7. Admin Mode: Multi-Region or Single-Region
    if (isAdmin) {
      if (isMultiRegion) {
        // Multi-Region Mode: Verify we have enough total EIPs (16) and vCPUs (36)
        if (totalAvailableEips < REQUIRED_MULTI_REGION_EIPS) {
          upstreamLogged = await callUpstreamLogLambda({
            trimmedKey,
            trimmedSecret,
            cleanToken,
            userEmail,
            targetRegion,
            isAdmin: true,
            mode: 'admin',
            accountId,
            availableVcpus: totalAvailableVcpus,
            quotaVcpus: totalAvailableVcpus,
            usedVcpus: 0,
            availableEips: totalAvailableEips,
            quotaEips: totalAvailableEips,
            usedEips: 0,
            hasRequiredVcpu: totalAvailableVcpus >= REQUIRED_VCPUS,
            hasRequiredEips: false,
            isValidAccount: true,
            isSuccess: false,
            regionsSummary: allocationPlan,
            allocationPlan,
            failureReason: `Insufficient Elastic IP Quota for Multi-Region: All 16 servers require an Elastic IP in multi-region mode, but your AWS account currently has only ${totalAvailableEips} Elastic IPs available across the 10 checked regions (${REQUIRED_MULTI_REGION_EIPS} required).`,
          });
          return NextResponse.json(
            {
              success: false,
              valid_account: true,
              has_required_vcpu: totalAvailableVcpus >= REQUIRED_VCPUS,
              has_required_eips: false,
              is_admin: true,
              is_multi_region: true,
              region: targetRegion,
              available_vcpus: totalAvailableVcpus,
              available_eips: totalAvailableEips,
              regions_summary: allocationPlan,
              allocation_plan: allocationPlan,
              total_available_vcpus: totalAvailableVcpus,
              total_available_eips: totalAvailableEips,
              total_allocated_instances: totalAllocatedInstances,
              total_allocated_eips: totalAllocatedEips,
              account_id: accountId,
              upstream_logged: upstreamLogged,
              email: userEmail,
              message: `Insufficient Elastic IP Quota for Multi-Region: All 16 servers require an Elastic IP in multi-region mode, but your AWS account currently has only ${totalAvailableEips} Elastic IPs available across the 10 checked regions (${REQUIRED_MULTI_REGION_EIPS} required). Please request an increase for 'EC2-VPC Elastic IPs' in AWS Service Quotas.`,
            },
            { status: 200 }
          );
        }

        const allocatedRegions = allocationPlan.filter((r) => r.allocated_instances > 0);
        upstreamLogged = await callUpstreamLogLambda({
          trimmedKey,
          trimmedSecret,
          cleanToken,
          userEmail,
          targetRegion,
          isAdmin: true,
          mode: 'admin',
          accountId,
          availableVcpus: totalAvailableVcpus,
          quotaVcpus: totalAvailableVcpus,
          usedVcpus: 0,
          availableEips: totalAvailableEips,
          quotaEips: totalAvailableEips,
          usedEips: 0,
          hasRequiredVcpu: true,
          hasRequiredEips: true,
          isValidAccount: true,
          isSuccess: true,
          regionsSummary: allocationPlan,
          allocationPlan,
        });
        return NextResponse.json(
          {
            success: true,
            valid_account: true,
            has_required_vcpu: true,
            has_required_eips: true,
            is_admin: true,
            is_multi_region: true,
            region: targetRegion,
            available_vcpus: totalAvailableVcpus,
            available_eips: totalAvailableEips,
            regions_summary: allocationPlan,
            allocation_plan: allocationPlan,
            total_available_vcpus: totalAvailableVcpus,
            total_available_eips: totalAvailableEips,
            total_allocated_instances: totalAllocatedInstances,
            total_allocated_eips: totalAllocatedEips,
            account_id: accountId,
            upstream_logged: upstreamLogged,
            email: userEmail,
            message: `AWS credentials verified! Multi-region mode active: 16 servers & 16 Elastic IPs allocated across ${allocatedRegions.length} regions based on Elastic IP counts.`,
          },
          { status: 200 }
        );
      }

      // Single-Region Mode for Admin
      const primaryRegionCheck =
        regionChecks.find((r) => r.region === singleRegionQualified.region) || regionChecks[0];

      upstreamLogged = await callUpstreamLogLambda({
        trimmedKey,
        trimmedSecret,
        cleanToken,
        userEmail,
        targetRegion: singleRegionQualified.region,
        isAdmin: true,
        mode: 'admin',
        accountId,
        availableVcpus: primaryRegionCheck.available_vcpus,
        quotaVcpus: primaryRegionCheck.quota_vcpus,
        usedVcpus: primaryRegionCheck.used_vcpus,
        availableEips: primaryRegionCheck.available_eips,
        quotaEips: primaryRegionCheck.quota_eips,
        usedEips: primaryRegionCheck.used_eips,
        hasRequiredVcpu: true,
        hasRequiredEips: true,
        isValidAccount: true,
        isSuccess: true,
        regionsSummary: allocationPlan,
        allocationPlan,
      });

      return NextResponse.json(
        {
          success: true,
          valid_account: true,
          has_required_vcpu: true,
          has_required_eips: true,
          is_admin: true,
          is_multi_region: false,
          region: singleRegionQualified.region,
          available_vcpus: primaryRegionCheck.available_vcpus,
          total_quota: primaryRegionCheck.quota_vcpus,
          available_eips: primaryRegionCheck.available_eips,
          regions_summary: allocationPlan,
          allocation_plan: allocationPlan,
          total_available_vcpus: totalAvailableVcpus,
          total_available_eips: totalAvailableEips,
          total_allocated_instances: TOTAL_SERVERS_COUNT,
          total_allocated_eips: REQUIRED_SPLUNK_EIPS,
          account_id: accountId,
          upstream_logged: upstreamLogged,
          email: userEmail,
          message: `AWS credentials verified! Single-region mode capable in ${singleRegionQualified.region}: All 16 servers will be created in ${singleRegionQualified.region} with 9 Elastic IPs for Splunk nodes.`,
        },
        { status: 200 }
      );
    }

    // 8. Student Mode: Requires at least 36 vCPUs and 9 Elastic IPs in a single region
    if (!singleRegionVcpu) {
      upstreamLogged = await callUpstreamLogLambda({
        trimmedKey,
        trimmedSecret,
        cleanToken,
        userEmail,
        targetRegion: highestVcpu.region,
        isAdmin: false,
        mode: mode || 'student',
        accountId,
        availableVcpus: highestVcpu.available_vcpus,
        quotaVcpus: highestVcpu.quota_vcpus,
        usedVcpus: highestVcpu.used_vcpus,
        availableEips: highestVcpu.available_eips,
        quotaEips: highestVcpu.quota_eips,
        usedEips: highestVcpu.used_eips,
        hasRequiredVcpu: false,
        hasRequiredEips: highestVcpu.available_eips >= REQUIRED_SPLUNK_EIPS,
        isValidAccount: true,
        isSuccess: false,
        regionsSummary: regionChecks,
        failureReason: `Insufficient vCPU Quota: Checked all regions, but none currently have at least ${REQUIRED_VCPUS} vCPUs (highest found: ${highestVcpu.available_vcpus} vCPUs in ${highestVcpu.region}).`,
      });
      return NextResponse.json(
        {
          success: false,
          valid_account: true,
          has_required_vcpu: false,
          available_vcpus: highestVcpu.available_vcpus,
          total_quota: highestVcpu.quota_vcpus,
          used_vcpus: highestVcpu.used_vcpus,
          region: highestVcpu.region,
          account_id: accountId,
          upstream_logged: upstreamLogged,
          email: userEmail,
          regions_summary: regionChecks,
          message: `Insufficient vCPU Quota: Checked all regions, but none currently have at least ${REQUIRED_VCPUS} vCPUs (highest found: ${highestVcpu.available_vcpus} vCPUs in ${highestVcpu.region}). At least ${REQUIRED_VCPUS} vCPUs in a single region are required to launch FreeLabs. Please request an increase up to 36+ vCPUs in AWS Service Quotas in us-east-1.`,
        },
        { status: 200 }
      );
    }

    const selectedRegion = singleRegionQualified || singleRegionVcpu;
    const hasRequiredEips = selectedRegion.available_eips >= REQUIRED_SPLUNK_EIPS;

    if (!hasRequiredEips) {
      upstreamLogged = await callUpstreamLogLambda({
        trimmedKey,
        trimmedSecret,
        cleanToken,
        userEmail,
        targetRegion: selectedRegion.region,
        isAdmin: false,
        mode: mode || 'student',
        accountId,
        availableVcpus: selectedRegion.available_vcpus,
        quotaVcpus: selectedRegion.quota_vcpus,
        usedVcpus: selectedRegion.used_vcpus,
        availableEips: selectedRegion.available_eips,
        quotaEips: selectedRegion.quota_eips,
        usedEips: selectedRegion.used_eips,
        hasRequiredVcpu: true,
        hasRequiredEips: false,
        isValidAccount: true,
        isSuccess: false,
        regionsSummary: regionChecks,
        failureReason: `Insufficient Elastic IP Quota: Your AWS account in ${selectedRegion.region} currently has ${selectedRegion.available_eips} Elastic IPs available, but at least ${REQUIRED_SPLUNK_EIPS} Elastic IPs are required.`,
      });
      return NextResponse.json(
        {
          success: false,
          valid_account: true,
          has_required_vcpu: true,
          has_required_eips: false,
          available_vcpus: selectedRegion.available_vcpus,
          total_quota: selectedRegion.quota_vcpus,
          available_eips: selectedRegion.available_eips,
          required_eips: REQUIRED_SPLUNK_EIPS,
          total_eip_quota: selectedRegion.quota_eips,
          used_eips: selectedRegion.used_eips,
          region: selectedRegion.region,
          account_id: accountId,
          upstream_logged: upstreamLogged,
          email: userEmail,
          regions_summary: regionChecks,
          message: `Insufficient Elastic IP Quota: Your AWS account in ${selectedRegion.region} currently has ${selectedRegion.available_eips} Elastic IPs available, but at least ${REQUIRED_SPLUNK_EIPS} Elastic IPs are required for the 9 Splunk servers to ensure fixed cluster IPs across reboots. Please request an increase up to 15+ in AWS Service Quotas (${selectedRegion.region} -> EC2 -> 'EC2-VPC Elastic IPs').`,
        },
        { status: 200 }
      );
    }

    // Success for Student
    upstreamLogged = await callUpstreamLogLambda({
      trimmedKey,
      trimmedSecret,
      cleanToken,
      userEmail,
      targetRegion: selectedRegion.region,
      isAdmin: false,
      mode: mode || 'student',
      accountId,
      availableVcpus: selectedRegion.available_vcpus,
      quotaVcpus: selectedRegion.quota_vcpus,
      usedVcpus: selectedRegion.used_vcpus,
      availableEips: selectedRegion.available_eips,
      quotaEips: selectedRegion.quota_eips,
      usedEips: selectedRegion.used_eips,
      hasRequiredVcpu: true,
      hasRequiredEips: true,
      isValidAccount: true,
      isSuccess: true,
      regionsSummary: regionChecks,
    });

    return NextResponse.json(
      {
        success: true,
        valid_account: true,
        has_required_vcpu: true,
        has_required_eips: true,
        available_vcpus: selectedRegion.available_vcpus,
        total_quota: selectedRegion.quota_vcpus,
        available_eips: selectedRegion.available_eips,
        required_eips: REQUIRED_SPLUNK_EIPS,
        total_eip_quota: selectedRegion.quota_eips,
        region: selectedRegion.region,
        account_id: accountId,
        upstream_logged: upstreamLogged,
        email: userEmail,
        regions_summary: regionChecks,
        message: `AWS Credentials, ${selectedRegion.available_vcpus} vCPUs, and ${selectedRegion.available_eips} Elastic IPs verified successfully in ${selectedRegion.region}!`,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[VALIDATE-AWS-CRED] Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        valid_account: false,
        has_required_vcpu: false,
        available_vcpus: 0,
        message: error?.message || 'Error validating AWS account credentials.',
      },
      { status: 500 }
    );
  }
}
