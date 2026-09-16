import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const BACKEND_URL = (
  process.env.NEXT_PUBLIC_AUTH_URL ||
  process.env.AUTH_URL ||
  ''
).replace(/\/+$/, '');

export async function GET(request: NextRequest) {
  try {
    const accessToken =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value;

    if (!accessToken) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    if (!BACKEND_URL) {
      // If auth URL is not configured but cookie is present, treat as authenticated
      return NextResponse.json(
        { authenticated: true, hasToken: true },
        { status: 200 },
      );
    }

    const { response, refreshSetCookies } = await authenticatedBackendFetch(
      request,
      `${BACKEND_URL}/user/profile`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    const data = await response.json();
    const nextResponse = NextResponse.json(
      { authenticated: true, user: data?.user || data?.profile || data },
      { status: 200 },
    );

    for (const cookie of refreshSetCookies) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }

    return nextResponse;
  } catch (error) {
    console.error('Profile fetch error:', error);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
