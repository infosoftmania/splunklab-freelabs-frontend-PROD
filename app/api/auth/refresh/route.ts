import { NextRequest, NextResponse } from 'next/server';
import { getCoordinatedRefresh, decodeJwtPayload } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const refreshToken =
      req.cookies.get('refresh_token')?.value || body?.refresh_token;
    const sessionId =
      req.cookies.get('session_id')?.value ||
      req.cookies.get('session_token')?.value ||
      body?.session_id;

    if (!refreshToken || !sessionId) {
      return NextResponse.json(
        { success: false, message: 'No refresh token or session found' },
        { status: 401 }
      );
    }

    const refreshResult = await getCoordinatedRefresh(refreshToken, sessionId);
    if (!refreshResult.accessToken) {
      const res = NextResponse.json(
        { success: false, message: 'Failed to refresh access token' },
        { status: 401 }
      );
      for (const cookie of refreshResult.setCookies) {
        res.headers.append('Set-Cookie', cookie);
      }
      return res;
    }

    const decoded = decodeJwtPayload(refreshResult.accessToken) || {};
    const user = {
      email: decoded.email || decoded.email_id || '',
      name: decoded.name || decoded.first_name || '',
      picture: decoded.picture || '',
      ...decoded,
    };

    const res = NextResponse.json(
      {
        success: true,
        token: refreshResult.accessToken,
        access_token: refreshResult.accessToken,
        user,
      },
      { status: 200 }
    );

    for (const cookie of refreshResult.setCookies) {
      res.headers.append('Set-Cookie', cookie);
    }

    return res;
  } catch (error: any) {
    console.error('[AUTH-REFRESH] Error:', error);
    return NextResponse.json(
      { success: false, message: error?.message || 'Token refresh error' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
