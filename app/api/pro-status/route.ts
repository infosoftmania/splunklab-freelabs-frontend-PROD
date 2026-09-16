import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const API_URL = (
  process.env.NEXT_PUBLIC_SPLUNKLAB_MAIN_API_URL ||
  process.env.SPLUNKLAB_MAIN_API_URL ||
  process.env.AWS_LABS_API_URL ||
  ''
).replace(/\/+$/, '');

export async function GET(request: NextRequest) {
  try {
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

    const email = request.headers.get('x-user-email') || request.nextUrl.searchParams.get('email');
    if (email) {
      headers['x-user-email'] = email;
    }

    const { response, refreshSetCookies } = await authenticatedBackendFetch(
      request,
      `${API_URL}/provisioning-status`,
      {
        headers,
        cache: 'no-store',
      },
    );

    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message = (data?.message as string) || (data?.error as string) || 'Upstream API failed';
      const errResponse = NextResponse.json(
        { error: message },
        { status: response.status },
      );
      for (const cookie of refreshSetCookies) {
        errResponse.headers.append('Set-Cookie', cookie);
      }
      return errResponse;
    }

    const nextResponse = NextResponse.json(data, { status: response.status });
    for (const cookie of refreshSetCookies) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }

    return nextResponse;
  } catch (error: unknown) {
    console.error('Provisioning status proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch provisioning status' },
      { status: 500 },
    );
  }
}
