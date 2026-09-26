import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken, decodeJwtPayload } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { token: activeToken, setCookies, refreshed } = await getValidAccessToken(request);

    if (!activeToken) {
      const res = NextResponse.json({ authenticated: false }, { status: 200 });
      for (const cookie of setCookies) {
        res.headers.append('Set-Cookie', cookie);
      }
      return res;
    }

    const decoded = decodeJwtPayload(activeToken) || {};
    const user = {
      email: decoded.email || decoded.email_id || '',
      name: decoded.name || decoded.first_name || '',
      picture: decoded.picture || '',
      ...decoded,
    };

    const res = NextResponse.json(
      { authenticated: true, user, token: activeToken, refreshed },
      { status: 200 }
    );

    for (const cookie of setCookies) {
      res.headers.append('Set-Cookie', cookie);
    }

    return res;
  } catch (error) {
    console.error('[PROFILE] Fetch error:', error);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
