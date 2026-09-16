import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AUTH_API = (
  process.env.NEXT_PUBLIC_AUTH_URL ||
  process.env.AUTH_URL ||
  ''
).replace(/\/+$/, '');

const expiredCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  expires: new Date(0),
};

export async function POST(request: NextRequest) {
  try {
    const sessionId = request.cookies.get('session_id')?.value;
    const accessToken =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value;

    if (sessionId && AUTH_API) {
      await fetch(`${AUTH_API}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ session_id: sessionId }),
        cache: 'no-store',
      }).catch((err) => console.error('Backend logout request failed:', err));
    }

    const response = NextResponse.json({
      success: true,
      message: 'Logged out successfully',
    });

    for (const name of [
      'token',
      'access_token',
      'refresh_token',
      'session_id',
      'google_token',
      'showcase_id',
    ]) {
      response.cookies.set(name, '', expiredCookieOptions);
    }

    return response;
  } catch (error) {
    console.error('Logout error:', error);
    const response = NextResponse.json(
      { success: false, message: 'Logout failed' },
      { status: 500 },
    );

    for (const name of [
      'token',
      'access_token',
      'refresh_token',
      'session_id',
      'google_token',
      'showcase_id',
    ]) {
      response.cookies.set(name, '', expiredCookieOptions);
    }

    return response;
  }
}
