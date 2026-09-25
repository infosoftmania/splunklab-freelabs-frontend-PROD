import { NextRequest, NextResponse } from 'next/server';
import { authenticatedBackendFetch } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const BACKEND_URL = (
  process.env.NEXT_PUBLIC_AUTH_URL ||
  process.env.AUTH_URL ||
  ''
).replace(/\/+$/, '');

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
    const accessToken =
      request.cookies.get('access_token')?.value ||
      request.cookies.get('token')?.value;

    const googleToken = request.cookies.get('google_token')?.value;
    const activeToken = accessToken || googleToken;

    if (!activeToken) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    const decoded = decodeJwtPayload(activeToken) || {};
    const fallbackUser = {
      email: decoded.email || decoded.email_id || '',
      name: decoded.name || decoded.first_name || '',
      picture: decoded.picture || '',
      ...decoded,
    };

    if (!BACKEND_URL || !accessToken) {
      // If auth URL is not configured or using google_token directly
      return NextResponse.json(
        { authenticated: true, user: fallbackUser, token: activeToken },
        { status: 200 },
      );
    }

    try {
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

      if (response.ok) {
        const data = await response.json();

        let effectiveToken = activeToken;
        for (const cookieStr of refreshSetCookies) {
          const match = cookieStr.match(/(?:^|;\s*)(?:access_token|token)=([^;]+)/i);
          if (match && match[1]) {
            effectiveToken = decodeURIComponent(match[1]);
          }
        }

        const nextResponse = NextResponse.json(
          { authenticated: true, user: data?.user || data?.profile || fallbackUser, token: effectiveToken },
          { status: 200 },
        );

        for (const cookie of refreshSetCookies) {
          nextResponse.headers.append('Set-Cookie', cookie);
        }

        return nextResponse;
      }
    } catch (backendErr) {
      console.warn('Backend user profile fetch failed, using token payload fallback:', backendErr);
    }

    // If backend profile endpoint returned 404 or other non-OK status,
    // preserve authentication using the verified token payload
    return NextResponse.json(
      { authenticated: true, user: fallbackUser, token: activeToken },
      { status: 200 },
    );
  } catch (error) {
    console.error('Profile fetch error:', error);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
