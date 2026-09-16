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
    const { instances, ssh_user } = body || {};

    if (!instances || !Array.isArray(instances) || instances.length === 0 || !ssh_user) {
      return NextResponse.json(
        { error: 'instances and ssh_user are required fields' },
        { status: 400 },
      );
    }

    const token =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value ||
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

    if (!token && !request.cookies.get('refresh_token')?.value) {
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

    const email = request.headers.get('x-user-email');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (email) {
      headers['x-user-email'] = email;
    }

    const { response, refreshSetCookies } = await authenticatedBackendFetch(
      request,
      `${API_URL}/cluster-config`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ instances, ssh_user }),
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
