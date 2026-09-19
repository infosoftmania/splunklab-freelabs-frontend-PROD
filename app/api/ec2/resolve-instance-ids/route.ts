import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

export const dynamic = 'force-dynamic';

const API_URL = (
  process.env.NEXT_PUBLIC_SPLUNKLAB_MAIN_API_URL ||
  process.env.SPLUNKLAB_MAIN_API_URL ||
  process.env.AWS_LABS_API_URL ||
  ''
).replace(/\/+$/, '');

const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ap-south-1',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'sa-east-1',
  'ca-central-1',
];

function extractPublicIp(instance: any): string | null {
  if (!instance || typeof instance !== 'object') return null;

  const possibleIpProps = [
    'PublicIpAddress',
    'PublicIp',
    'PublicIP',
    'Public IP',
    'publicIp',
    'public_ip',
    'public_ip_address',
    'publicIpAddress',
    'ip',
    'IP',
    'ipAddress',
    'IpAddress',
  ];

  for (const prop of possibleIpProps) {
    const val = instance[prop];
    if (typeof val === 'string' && val.trim()) {
      const match = val.trim().match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      if (match) return match[0];
    }
  }

  // Check SSHCommand e.g. "ssh -i key.pem ec2-user@13.223.200.73"
  if (typeof instance.SSHCommand === 'string') {
    const match = instance.SSHCommand.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    if (match) return match[0];
  }

  // Check PrivateIpAddress as fallback
  const privateIpProps = ['PrivateIpAddress', 'PrivateIp', 'private_ip', 'privateIp'];
  for (const prop of privateIpProps) {
    const val = instance[prop];
    if (typeof val === 'string' && val.trim()) {
      const match = val.trim().match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      if (match) return match[0];
    }
  }

  // Fallback: scan all string values for an IPv4 pattern
  for (const key of Object.keys(instance)) {
    const v = instance[key];
    if (typeof v === 'string') {
      const match = v.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      if (match) return match[0];
    }
  }

  return null;
}

function extractInstanceId(instance: any): string | null {
  if (!instance || typeof instance !== 'object') return null;

  const possibleIdProps = [
    'InstanceId',
    'instance_id',
    'instanceId',
    'id',
    'Id',
    'instanceID',
    'InstanceID',
    'instance_Id',
  ];

  for (const prop of possibleIdProps) {
    const val = instance[prop];
    if (typeof val === 'string' && val.trim()) {
      const match = val.trim().match(/\bi-[0-9a-fA-F]{8,20}\b/);
      if (match) return match[0];
    }
  }

  // Fallback: scan all string values for instance ID pattern
  for (const key of Object.keys(instance)) {
    const v = instance[key];
    if (typeof v === 'string') {
      const match = v.match(/\bi-[0-9a-fA-F]{8,20}\b/);
      if (match) return match[0];
    }
  }

  return null;
}

function collectInstances(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => collectInstances(item));
  }
  if (typeof raw !== 'object') return [];

  const results: any[] = [];

  if (extractInstanceId(raw) || extractPublicIp(raw)) {
    results.push(raw);
  }

  // Unpack stringified JSON body if present
  if (typeof raw.body === 'string') {
    try {
      const parsedBody = JSON.parse(raw.body);
      results.push(...collectInstances(parsedBody));
    } catch {
      // ignore parse error
    }
  }

  if (Array.isArray(raw.instances)) results.push(...collectInstances(raw.instances));
  if (Array.isArray(raw.Instances)) results.push(...collectInstances(raw.Instances));
  if (Array.isArray(raw.data)) results.push(...collectInstances(raw.data));
  if (Array.isArray(raw.records)) results.push(...collectInstances(raw.records));
  if (Array.isArray(raw.Records)) results.push(...collectInstances(raw.Records));
  if (Array.isArray(raw.items)) results.push(...collectInstances(raw.items));
  if (Array.isArray(raw.Reservations)) {
    for (const res of raw.Reservations) {
      if (Array.isArray(res.Instances)) results.push(...collectInstances(res.Instances));
    }
  }

  return results;
}

/**
 * POST /api/ec2/resolve-instance-ids
 * Body: { publicIps: string[], email?: string, region?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const publicIps: string[] = body?.publicIps || [];
    const requestedEmail: string = body?.email || request.headers.get('x-user-email') || '';

    if (!Array.isArray(publicIps) || publicIps.length === 0) {
      return NextResponse.json({ error: 'publicIps array is required' }, { status: 400 });
    }

    const token =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value ||
      request.cookies.get('google_token')?.value ||
      request.cookies.get('refresh_token')?.value ||
      request.headers.get('authorization');

    if (!token && !requestedEmail) {
      return NextResponse.json(
        { error: 'Unauthorized. Please sign in with Google to proceed.' },
        { status: 401 },
      );
    }

    const mapping: Record<string, string> = {};
    const refreshSetCookiesList: string[] = [];

    const recordInstance = (inst: any) => {
      const ip = extractPublicIp(inst);
      const id = extractInstanceId(inst);
      if (ip && id) {
        mapping[ip] = id;
      }
    };

    const hasAllIps = () => publicIps.every((ip) => Boolean(mapping[ip]));

    // Step 1: Direct AWS EC2 resolution (fastest, queries the active AWS account directly)
    try {
      const primaryRegion = body?.region || process.env.AWS_REGION || 'us-east-1';
      const regionsToQuery = [primaryRegion, ...AWS_REGIONS.filter((r) => r !== primaryRegion)];

      for (const reg of regionsToQuery) {
        if (hasAllIps()) break;
        try {
          const clientConfig: {
            region: string;
            credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
          } = {
            region: reg,
          };

          if (body?.aws_access_key && body?.aws_secret_key) {
            clientConfig.credentials = {
              accessKeyId: String(body.aws_access_key).trim(),
              secretAccessKey: String(body.aws_secret_key).trim(),
              sessionToken: body.aws_session_token ? String(body.aws_session_token).trim() : undefined,
            };
          }

          const ec2Client = new EC2Client(clientConfig);
          const ec2Res = await ec2Client.send(
            new DescribeInstancesCommand({
              Filters: [
                {
                  Name: 'instance-state-name',
                  Values: ['pending', 'running', 'stopped', 'stopping'],
                },
              ],
            }),
          );

          for (const res of ec2Res.Reservations || []) {
            for (const inst of res.Instances || []) {
              recordInstance(inst);
            }
          }
        } catch {
          // Continue checking next region or fallbacks
        }
      }
    } catch (ec2Err) {
      console.warn('Direct EC2 describe error:', ec2Err);
    }

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (requestedEmail) {
      reqHeaders['x-user-email'] = requestedEmail;
    }

    // Step 2: Fallback to main user instances endpoint (/instances)
    if (!hasAllIps() && API_URL) {
      try {
      const { response, refreshSetCookies } = await authenticatedBackendFetch(
        request,
        `${API_URL}/instances`,
        {
          method: 'GET',
          headers: reqHeaders,
          cache: 'no-store',
        },
      );
      for (const cookie of refreshSetCookies) refreshSetCookiesList.push(cookie);

      if (response.ok) {
        const data = await response.json();
        const instances = collectInstances(data);
        for (const inst of instances) {
          recordInstance(inst);
        }
      }
    } catch (err) {
      console.warn('Failed to query /instances endpoint:', err);
    }
    }

    // Step 3: If still missing IPs, query /ec2/instances across all common regions in parallel
    if (!hasAllIps() && API_URL) {
      const regionPromises = AWS_REGIONS.map(async (region) => {
        try {
          const { response, refreshSetCookies } = await authenticatedBackendFetch(
            request,
            `${API_URL}/ec2/instances?region=${encodeURIComponent(region)}`,
            {
              method: 'GET',
              headers: reqHeaders,
              cache: 'no-store',
            },
          );
          for (const cookie of refreshSetCookies) refreshSetCookiesList.push(cookie);

          if (response.ok) {
            const data = await response.json();
            const instances = collectInstances(data);
            for (const inst of instances) {
              recordInstance(inst);
            }
          }
        } catch {
          // ignore region failures
        }
      });

      await Promise.allSettled(regionPromises);
    }

    // Step 4: If still missing IPs, query /provisioning-status fallback
    if (!hasAllIps() && API_URL) {
      try {
        const { response, refreshSetCookies } = await authenticatedBackendFetch(
          request,
          `${API_URL}/provisioning-status`,
          {
            method: 'GET',
            headers: reqHeaders,
            cache: 'no-store',
          },
        );
        for (const cookie of refreshSetCookies) refreshSetCookiesList.push(cookie);

        if (response.ok) {
          const data = await response.json();
          const instances = collectInstances(data);
          for (const inst of instances) {
            recordInstance(inst);
          }
        }
      } catch {
        // ignore
      }
    }

    const unresolved = publicIps.filter((ip) => !mapping[ip]);

    const nextResponse = NextResponse.json(
      {
        mapping,
        unresolved,
        resolvedCount: Object.keys(mapping).length,
      },
      { status: 200 },
    );

    for (const cookie of refreshSetCookiesList) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }

    return nextResponse;
  } catch (error: unknown) {
    console.error('Resolve instance IDs error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve instance IDs' },
      { status: 500 },
    );
  }
}
