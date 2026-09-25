import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    const googleToken = request.cookies.get('google_token')?.value;
    const activeToken = accessToken || googleToken;

    if (!activeToken) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    const decoded = decodeJwtPayload(activeToken) || {};
    const user = {
      email: decoded.email || decoded.email_id || '',
      name: decoded.name || decoded.first_name || '',
      picture: decoded.picture || '',
      ...decoded,
    };

    return NextResponse.json(
      { authenticated: true, user, token: activeToken },
      { status: 200 },
    );
  } catch (error) {
    console.error('Profile fetch error:', error);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
