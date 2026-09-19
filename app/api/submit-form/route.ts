import { NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      aws_access_key,
      aws_secret_key,
      region,
      key_pair_name,
      action = 'PROVISION',
      user_email: raw_user_email,
      user_name: raw_user_name,
      codebuild_projects: raw_codebuild_projects,
      lab_id: raw_lab_id,
    } = body;

    // 1. Extract email
    const user_email =
      raw_user_email ||
      body.email ||
      (typeof raw_user_name === 'string' && raw_user_name.includes('@') ? raw_user_name : '');

    // 2. Derive clean user_name: alphanumeric/underscore
    let user_name = raw_user_name || '';
    if (!user_name || user_name.includes('@')) {
      if (user_email) {
        user_name = user_email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
      } else {
        user_name = 'student';
      }
    }

    const API_URL =
      process.env.FREELABS_API_URL ||
      process.env.NEXT_PUBLIC_FREELABS_API_URL ||
      'https://wkn4icbie8.execute-api.us-east-1.amazonaws.com/freelabs';

    const currentAction = String(action).toUpperCase();

    // -------------------------------------------------------------
    // ACTION: STATUS (Polled by UI to check if instances are ready)
    // -------------------------------------------------------------
    if (currentAction === 'STATUS') {
      const targetLabId = raw_lab_id || body.run_id || '';
      if (!aws_access_key || !aws_secret_key || !region || !user_name) {
        return NextResponse.json(
          { success: false, message: 'AWS credentials, region, and user_name are required for status check' },
          { status: 400 }
        );
      }

      const statusPayload = {
        action: 'STATUS',
        user_name,
        user_email,
        lab_id: targetLabId,
        region,
        aws_access_key,
        aws_secret_key,
        codebuild_projects: ['project 5'],
      };

      try {
        const statusResp = await fetch(API_URL, {
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
          };
        }

        return NextResponse.json(
          {
            success: true,
            status: statusJson?.status || 'OK',
            instance_count: statusJson?.instance_count || Object.keys(servers).length,
            servers,
            instances: rawInstances,
            lab_id: targetLabId,
          },
          { status: 200 }
        );
      } catch (err: any) {
        return NextResponse.json(
          { success: false, message: err.message || 'Status check failed' },
          { status: 500 }
        );
      }
    }

    // -------------------------------------------------------------
    // ACTION: PROVISION
    // -------------------------------------------------------------
    if (
      !aws_access_key ||
      !aws_secret_key ||
      !region ||
      !key_pair_name ||
      (!user_email && !user_name)
    ) {
      return NextResponse.json(
        { success: false, message: 'All fields are required (AWS credentials, region, key pair, email)' },
        { status: 400 }
      );
    }

    const lab_id = raw_lab_id || `freelab_${Math.floor(Date.now() / 1000)}`;

    const backendPayload: Record<string, any> = {
      action: 'PROVISION',
      user_name,
      user_email,
      key_pair_name,
      region,
      aws_access_key,
      aws_secret_key,
      codebuild_projects: ['project 5'],
      lab_id,
    };

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backendPayload),
    });

    const responseText = await response.text();
    let data: any = null;

    try {
      data = responseText ? JSON.parse(responseText) : null;
      if (data && typeof data === 'object' && 'body' in data && typeof data.body === 'string') {
        try {
          const inner = JSON.parse(data.body);
          data = { ...data, ...inner, parsed_body: inner };
        } catch {
          // keep as is
        }
      }
    } catch {
      data = { raw: responseText };
    }

    const upstreamMessage =
      typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : undefined;

    // If API Gateway timed out at 30 seconds (503 Service Unavailable / 504 Gateway Timeout),
    // the Lambda function is already executing in AWS background and will finish creating instances.
    // Return HTTP 200 with status: "IN_PROGRESS" so the frontend displays "Environment setup please wait..."
    if (
      !response.ok &&
      (response.status === 503 ||
        response.status === 504 ||
        upstreamMessage?.includes('Service Unavailable') ||
        upstreamMessage?.includes('timed out'))
    ) {
      console.log(`[SUBMIT-FORM] API Gateway returned ${response.status}. Provisioning started in background for lab_id: ${lab_id}`);
      return NextResponse.json(
        {
          success: true,
          status: 'IN_PROGRESS',
          message: 'Environment setup started. Please wait...',
          lab_id,
          data: {
            status: 'IN_PROGRESS',
            lab_id,
            user_name,
            user_email,
          },
        },
        { status: 200 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: upstreamMessage || 'Provisioning API request failed',
          data,
        },
        { status: response.status }
      );
    }

    // Success response: could be immediate IN_PROGRESS (from async Lambda) or completed servers
    const resStatus = data?.status || 'IN_PROGRESS';
    const rawInstances = data?.instances || data?.parsed_body?.instances || {};
    const servers: Record<string, any> = {};
    for (const [sName, sData] of Object.entries(rawInstances)) {
      const s = sData as any;
      servers[sName] = {
        public_ip: s.public_ip || s.private_ip,
        private_ip: s.private_ip,
        instance_id: s.instance_id,
        state: s.state,
        region: s.region || region,
      };
    }

    return NextResponse.json(
      {
        success: true,
        status: resStatus,
        message: upstreamMessage || (resStatus === 'IN_PROGRESS' ? 'Environment setup started. Please wait...' : 'Environment provisioned successfully!'),
        lab_id,
        data: {
          status: resStatus,
          lab_id,
          user_name,
          user_email,
          servers: Object.keys(servers).length > 0 ? servers : undefined,
          instance_count: data?.instance_count || Object.keys(servers).length,
        },
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[SUBMIT-FORM] Error:', error);
    return NextResponse.json(
      { success: false, message: error?.message || 'Server error' },
      { status: 500 }
    );
  }
}
