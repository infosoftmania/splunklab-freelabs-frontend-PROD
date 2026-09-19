import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const API_URL = (
  process.env.NEXT_PUBLIC_SPLUNKLAB_MAIN_API_URL ||
  process.env.SPLUNKLAB_MAIN_API_URL ||
  process.env.AWS_LABS_API_URL ||
  ''
).replace(/\/+$/, '');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const isFreeLabs = Boolean(body?.servers && body?.pem_key);
    const endpoint = isFreeLabs ? `${API_URL}/free-labs/cluster-config` : `${API_URL}/cluster-config`;

    if (!isFreeLabs) {
      const { instances, ssh_user } = body || {};
      if (!instances || !Array.isArray(instances) || instances.length === 0 || !ssh_user) {
        return NextResponse.json(
          { error: 'servers (or instances) and ssh_user/pem_key are required fields' },
          { status: 400 },
        );
      }
    }

    const email = request.headers.get('x-user-email') || body?.email || '';
    const username = body?.username || (email ? email.split('@')[0] : 'student');

    const token =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value ||
      request.cookies.get('google_token')?.value ||
      request.cookies.get('refresh_token')?.value ||
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

    if (!token && !email) {
      return NextResponse.json(
        { error: 'Unauthorized. Please sign in with Google to proceed.' },
        { status: 401 },
      );
    }

    if (!API_URL) {
      return NextResponse.json(
        { error: 'Backend API URL is not configured' },
        { status: 500 },
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (email) {
      headers['x-user-email'] = email;
    }

    const triggerPayload: Record<string, unknown> = isFreeLabs
      ? {
          servers: body.servers,
          ssh_user: body.ssh_user || 'ec2-user',
          email,
          username,
          pem_key: body.pem_key,
          splunk_username: body.splunk_username || 'admin',
          splunk_password: body.splunk_password || 'admin123',
          origin: body.origin || 'freelabs',
          plan_start_date: body.plan_start_date || new Date().toISOString(),
        }
      : {
          instances: body.instances,
          ssh_user: body.ssh_user,
          email,
          username,
          ...(body?.plan_start_date ? { plan_start_date: body.plan_start_date } : {}),
        };

    const { response, refreshSetCookies } = await authenticatedBackendFetch(
      request,
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(triggerPayload),
        cache: 'no-store',
      },
    );

    let data: Record<string, unknown> = {};
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text || response.statusText };
    }

    const nextResponse = NextResponse.json(data, { status: response.status });
    for (const cookie of refreshSetCookies) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }

    return nextResponse;
  } catch (error: unknown) {
    console.error('Cluster trigger proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cluster configuration request failed' },
      { status: 500 },
    );
  }
}
