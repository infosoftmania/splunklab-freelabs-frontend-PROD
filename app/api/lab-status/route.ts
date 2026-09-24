import { NextResponse } from 'next/server';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

export const dynamic = 'force-dynamic';

const SCAN_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ap-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'eu-central-1',
  'eu-west-1',
];

async function scanAccountForFreeLabs(
  ak: string,
  sk: string,
  preferredLabId?: string
): Promise<{ labId?: string; instances: Record<string, any> }> {
  const promises = SCAN_REGIONS.map(async (reg) => {
    try {
      const ec2 = new EC2Client({
        region: reg,
        credentials: { accessKeyId: ak, secretAccessKey: sk },
      });
      const res = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
        })
      );
      const list: Array<{ name: string; labId?: string; data: any }> = [];
      for (const r of res.Reservations || []) {
        for (const inst of r.Instances || []) {
          const tags = (inst.Tags || []).reduce((acc: Record<string, string>, t) => {
            if (t.Key && t.Value) acc[t.Key] = t.Value;
            return acc;
          }, {});
          const instLabId = tags['LabId'];
          const name = tags['Name'] || inst.InstanceId || '';
          const isFreeLab =
            Boolean(instLabId) ||
            name.startsWith('FreeLab-') ||
            ['IDX1', 'IDX2', 'IDX3', 'SH1', 'SH2', 'SH3', 'ClusterMaster', 'Management_server', 'IHF'].includes(name);

          if (isFreeLab) {
            list.push({
              name,
              labId: instLabId,
              data: {
                public_ip: inst.PublicIpAddress || inst.PrivateIpAddress || 'N/A',
                private_ip: inst.PrivateIpAddress || 'N/A',
                instance_id: inst.InstanceId,
                state: inst.State?.Name || 'unknown',
                instance_type: inst.InstanceType,
                region: reg,
              },
            });
          }
        }
      }
      return list;
    } catch {
      return [];
    }
  });

  const settled = await Promise.allSettled(promises);
  const allInstances = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  if (allInstances.length === 0) {
    return { instances: {} };
  }

  // Count instances per LabId to find the active lab
  const labCounts: Record<string, number> = {};
  for (const item of allInstances) {
    const lid = item.labId || 'unknown';
    labCounts[lid] = (labCounts[lid] || 0) + 1;
  }

  // Select the best LabId: either preferredLabId if found, or the labId with the most instances
  let chosenLabId = preferredLabId && labCounts[preferredLabId] ? preferredLabId : undefined;
  if (!chosenLabId) {
    let maxCount = 0;
    for (const [lid, count] of Object.entries(labCounts)) {
      if (lid !== 'unknown' && count > maxCount) {
        maxCount = count;
        chosenLabId = lid;
      }
    }
  }

  const instancesMap: Record<string, any> = {};
  for (const item of allInstances) {
    if (!chosenLabId || item.labId === chosenLabId || !item.labId) {
      instancesMap[item.name] = item.data;
    }
  }

  return { labId: chosenLabId, instances: instancesMap };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      aws_access_key,
      aws_secret_key,
      region = 'us-east-1',
      user_email,
      user_name,
      lab_id,
    } = body;

    if (!aws_access_key || !aws_secret_key || !region || !user_name) {
      return NextResponse.json(
        { success: false, message: 'AWS credentials, region, and user_name are required' },
        { status: 400 }
      );
    }

    const STATUS_API_URL =
      process.env.FREELABS_STATUS_API_URL ||
      process.env.NEXT_PUBLIC_FREELABS_STATUS_API_URL ||
      'https://wkn4icbie8.execute-api.us-east-1.amazonaws.com/freelabs/status';

    const emailPrefix = user_email ? user_email.split('@')[0] : '';
    let targetLabId = lab_id || emailPrefix;
    let finalLabId = targetLabId;

    const statusPayload = {
      action: 'STATUS',
      user_name,
      user_email: user_email || `${user_name}@freelabs.io`,
      lab_id: targetLabId,
      region,
      aws_access_key,
      aws_secret_key,
    };

    let statusResp = await fetch(STATUS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statusPayload),
    });

    let statusText = await statusResp.text();
    let statusJson: any = null;
    try {
      statusJson = JSON.parse(statusText);
      if (statusJson && typeof statusJson.body === 'string') {
        statusJson = JSON.parse(statusJson.body);
      }
    } catch {
      statusJson = { message: statusText };
    }

    let rawInstances = statusJson?.instances || {};
    const servers: Record<string, any> = {};
    for (const [sName, sData] of Object.entries(rawInstances)) {
      const s = sData as any;
      servers[sName] = {
        public_ip: s.public_ip || s.private_ip,
        private_ip: s.private_ip,
        instance_id: s.instance_id,
        state: s.state,
        instance_type: s.instance_type,
        region: s.region || region,
      };
    }

    // Auto-Discovery Fallback: If 0 servers found for this lab_id, scan regions to locate existing lab
    if (Object.keys(servers).length === 0) {
      console.log(`[LAB-STATUS] No servers found with lab_id="${targetLabId}". Scanning AWS regions for active FreeLabs servers...`);
      const discovered = await scanAccountForFreeLabs(
        String(aws_access_key).trim(),
        String(aws_secret_key).trim(),
        lab_id
      );

      if (discovered.labId && discovered.labId !== targetLabId) {
        try {
          const retryResp = await fetch(STATUS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...statusPayload,
              lab_id: discovered.labId,
            }),
          });
          const retryText = await retryResp.text();
          let retryJson: any = null;
          try {
            retryJson = JSON.parse(retryText);
            if (retryJson && typeof retryJson.body === 'string') {
              retryJson = JSON.parse(retryJson.body);
            }
          } catch {
            retryJson = null;
          }

          if (retryJson?.instances && Object.keys(retryJson.instances).length > 0) {
            for (const [sName, sData] of Object.entries(retryJson.instances)) {
              const s = sData as any;
              servers[sName] = {
                public_ip: s.public_ip || s.private_ip,
                private_ip: s.private_ip,
                instance_id: s.instance_id,
                state: s.state,
                instance_type: s.instance_type,
                region: s.region || region,
              };
            }
            finalLabId = discovered.labId;
          }
        } catch (retryErr) {
          console.warn('[LAB-STATUS] Retry query warning:', retryErr);
        }
      }

      // If status API didn't return them but direct scan found instances, use direct scan instances
      if (Object.keys(servers).length === 0 && Object.keys(discovered.instances).length > 0) {
        Object.assign(servers, discovered.instances);
        finalLabId = discovered.labId || finalLabId;
      }
    }

    return NextResponse.json(
      {
        success: true,
        status: Object.keys(servers).length > 0 ? 'OK' : (statusJson?.status || 'NOT_FOUND'),
        instance_count: Object.keys(servers).length,
        servers,
        instances: rawInstances,
        lab_id: finalLabId,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[LAB-STATUS] Error:', err);
    return NextResponse.json(
      { success: false, message: err.message || 'Status check failed' },
      { status: 500 }
    );
  }
}
