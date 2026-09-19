import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const API_URL = (
  process.env.NEXT_PUBLIC_SPLUNKLAB_MAIN_API_URL ||
  process.env.SPLUNKLAB_MAIN_API_URL ||
  process.env.AWS_LABS_API_URL ||
  ''
).replace(/\/+$/, '');

const CODEBUILD_STATUS_URL = (
  process.env.FREELABS_CODEBUILD_STATUS_API_URL ||
  process.env.NEXT_PUBLIC_FREELABS_CODEBUILD_STATUS_API_URL ||
  (API_URL ? `${API_URL}/free-labs/codebuild-status` : '')
).replace(/\/+$/, '');

export async function GET(request: NextRequest) {
  try {
    const buildId = request.nextUrl.searchParams.get('build_id');

    // Secure status fetch via API Gateway for FreeLabs
    if (buildId && CODEBUILD_STATUS_URL) {
      try {
        const targetUrl = new URL(CODEBUILD_STATUS_URL);
        targetUrl.searchParams.set('build_id', buildId);

        const statusResponse = await fetch(targetUrl.toString(), {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });

        if (statusResponse.ok) {
          const data = await statusResponse.json();
          return NextResponse.json(data);
        }
      } catch (err) {
        console.warn('Backend codebuild-status fetch failed, trying fallback:', err);
      }
    }

    if (!API_URL) {
      return NextResponse.json(
        { error: 'Backend API URL is not configured' },
        { status: 500 },
      );
    }

    const url = new URL(`${API_URL}/cluster-config/status`);
    request.nextUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));

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
      url.toString(),
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
    console.error('Cluster status proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch cluster status' },
      { status: 500 },
    );
  }
}
