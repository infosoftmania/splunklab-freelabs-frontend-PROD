import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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
    const statusPayload = {
      action: 'STATUS',
      user_name,
      user_email: user_email || `${user_name}@freelabs.io`,
      lab_id: lab_id || emailPrefix,
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
      statusJson = JSON.parse(statusText);
      if (statusJson && typeof statusJson.body === 'string') {
        statusJson = JSON.parse(statusJson.body);
      }
    } catch {
      statusJson = { message: statusText };
    }

    const rawInstances = statusJson?.instances || {};
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

    return NextResponse.json(
      {
        success: true,
        status: statusJson?.status || 'OK',
        instance_count: statusJson?.instance_count || Object.keys(servers).length,
        servers,
        instances: rawInstances,
        lab_id: lab_id || statusJson?.lab_id,
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
