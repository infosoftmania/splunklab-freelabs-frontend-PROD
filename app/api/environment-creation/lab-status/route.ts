import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const STATUS_API_URL =
  process.env.FREELABS_STATUS_API_URL ||
  process.env.NEXT_PUBLIC_FREELABS_STATUS_API_URL ||
  'https://wkn4icbie8.execute-api.us-east-1.amazonaws.com/freelabs/status';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

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

    const emailPrefix = user_email ? String(user_email).split('@')[0] : '';
    const targetLabId = lab_id || emailPrefix;

    const statusPayload = {
      action: 'STATUS',
      user_name,
      user_email: user_email || `${user_name}@freelabs.io`,
      lab_id: targetLabId,
      region,
      aws_access_key,
      aws_secret_key,
    };

    const statusResp = await fetch(STATUS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statusPayload),
    });

    const statusText = await statusResp.text();
    let statusJson: any = null;

    try {
      statusJson = statusText ? JSON.parse(statusText) : {};
      if (statusJson && typeof statusJson === 'object' && typeof statusJson.body === 'string') {
        try {
          const inner = JSON.parse(statusJson.body);
          statusJson = { ...statusJson, ...inner };
        } catch {
          // keep as is
        }
      }
    } catch {
      statusJson = { message: statusText };
    }

    const rawInstances = statusJson?.instances || {};
    const servers: Record<string, any> = {};

    for (const [sName, sData] of Object.entries(rawInstances)) {
      const s = sData as any;
      servers[sName] = {
        public_ip: s?.public_ip || s?.private_ip || 'N/A',
        private_ip: s?.private_ip || 'N/A',
        instance_id: s?.instance_id || '',
        state: s?.state || 'unknown',
        instance_type: s?.instance_type || '',
        region: s?.region || region,
      };
    }

    const serverCount = Object.keys(servers).length;
    const isSuccess = serverCount > 0 || statusJson?.status === 'OK';

    return NextResponse.json(
      {
        success: isSuccess,
        status: serverCount > 0 ? 'OK' : statusJson?.status || 'NOT_FOUND',
        instance_count: statusJson?.instance_count || serverCount,
        servers,
        instances: rawInstances,
        lab_id: targetLabId,
        message: statusJson?.message,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[LAB-STATUS] Error calling status API:', err);
    return NextResponse.json(
      { success: false, message: err?.message || 'Status check failed' },
      { status: 500 }
    );
  }
}
