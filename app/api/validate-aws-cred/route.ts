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
    const authHeader = req.headers.get('authorization') || '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
    const cookieToken =
      req.cookies.get('google_token')?.value ||
      req.cookies.get('access_token')?.value ||
      req.cookies.get('token')?.value ||
      '';
    const activeToken = body?.token || body?.access_token || headerToken || cookieToken || '';

    let userEmail = body?.user_email || body?.email || '';
    if (!userEmail && activeToken) {
      userEmail = extractEmailFromToken(activeToken);
    }

    // 2. Notify upstream Lambda (Freelab-log) to log to Google Sheet
    // Note: Email is not sent in payload; only token is sent for Lambda to decode
    let upstreamLogged = false;
    let upstreamData: any = null;
    try {
      const upstreamResp = await fetch(AWS_CRED_VALIDATE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: trimmedKey,
          aws_secret_key: trimmedSecret,
          token: activeToken,
          region: targetRegion,
          timestamp: new Date().toISOString(),
        }),
      });
      upstreamLogged = upstreamResp.ok;
      const upstreamText = await upstreamResp.text();
      try {
        upstreamData = JSON.parse(upstreamText);
        if (upstreamData && typeof upstreamData.body === 'string') {
          upstreamData = JSON.parse(upstreamData.body);
        }
      } catch {
        upstreamData = { raw: upstreamText };
      }
    } catch (logErr) {
      console.warn('[VALIDATE-AWS-CRED] Upstream logging failed:', logErr);
    }

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

    // 6. Student Mode: Requires at least 36 vCPUs and 9 Elastic IPs in a single region
    if (!singleRegionVcpu) {
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
