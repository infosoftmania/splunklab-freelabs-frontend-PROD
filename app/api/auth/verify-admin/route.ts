import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken, getCoordinatedRefresh } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const ADMIN_VERIFY_API_URL =
  process.env.ADMIN_VERIFY_API_URL ||
  'https://u8eyhd99pc.execute-api.us-east-1.amazonaws.com/verify-admin';

/**
 * Checks if a JWT token was issued by the backend authorizer (my-auth-jwks / my-api)
 * rather than being a raw Google ID token (accounts.google.com).
 * API Gateway mrna7y authorizer strictly requires a my-auth-jwks issued access token.
 */
function isBackendAccessToken(t?: string): boolean {
  if (!t || typeof t !== 'string' || !t.includes('.')) return false;
  try {
    const parts = t.split('.');
    if (parts.length < 2) return false;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonStr);

    // Google ID tokens have accounts.google.com as issuer
    if (payload.iss && payload.iss.includes('accounts.google.com')) {
      return false;
    }

    // Backend tokens have my-auth-jwks issuer or my-api audience
    if (payload.iss?.includes('my-auth-jwks') || payload.aud === 'my-api') {
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the correct backend access token for API Gateway authorizer.
 * Prioritizes the backend access_token from cookies or body over raw Google tokens.
 */
function resolveBackendToken(req: NextRequest, bodyToken?: string): string {
  const cookieAccessToken = req.cookies.get('access_token')?.value;

  const authHeader = req.headers.get('authorization') || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';

  // 1. If explicit body/header token is already a backend token, use it
  if (isBackendAccessToken(bodyToken)) return bodyToken!;
  if (isBackendAccessToken(headerToken)) return headerToken;

  // 2. If browser has access_token cookie from backend auth, prioritize it
  if (cookieAccessToken) return cookieAccessToken;

  // 3. Fallback to any token provided
  return bodyToken || headerToken || req.cookies.get('google_token')?.value || '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawToken = resolveBackendToken(req, body?.token || body?.access_token);
    const { token: validToken, setCookies } = await getValidAccessToken(req, rawToken);
    let token = validToken;

    if (!token) {
      return NextResponse.json(
        {
          success: false,
          is_admin: false,
          message: 'User token is required for admin verification',
        },
        { status: 200 }
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };

    // Forward to upstream Lambda sending ONLY the token in Authorization header
    let response = await fetch(ADMIN_VERIFY_API_URL, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });

    let responseText = await response.text();
    let data: any = {};
    try {
      data = JSON.parse(responseText);
      if (data && typeof data.body === 'string') {
        data = JSON.parse(data.body);
      }
    } catch {
      data = { raw: responseText };
    }

    // If token expired/unauthorized, attempt refresh and retry
    const isTokenExpired =
      response.status === 401 ||
      (typeof data?.message === 'string' &&
        (data.message.toLowerCase().includes('expired') ||
          data.message.toLowerCase().includes('unauthorized') ||
          data.message.toLowerCase().includes('token')));

    if (isTokenExpired) {
      const refreshToken = req.cookies.get('refresh_token')?.value;
      const sessionId =
        req.cookies.get('session_id')?.value ||
        req.cookies.get('session_token')?.value;

      if (refreshToken && sessionId) {
        console.log('[VERIFY-ADMIN] Upstream token expired, attempting refresh...');
        const refreshResult = await getCoordinatedRefresh(refreshToken, sessionId);
        if (refreshResult.accessToken) {
          token = refreshResult.accessToken;
          headers['Authorization'] = `Bearer ${token}`;

          response = await fetch(ADMIN_VERIFY_API_URL, {
            method: 'GET',
            headers,
            cache: 'no-store',
          });

          responseText = await response.text();
          try {
            data = JSON.parse(responseText);
            if (data && typeof data.body === 'string') {
              data = JSON.parse(data.body);
            }
          } catch {
            data = { raw: responseText };
          }

          for (const c of refreshResult.setCookies) {
            setCookies.push(c);
          }
        }
      }
    }

    const isAdmin = Boolean(data?.is_admin === true || data?.isAdmin === true);

    const nextResponse = NextResponse.json({
      success: true,
      is_admin: isAdmin,
      email: data?.email || '',
      token,
      data,
    });

    for (const cookie of setCookies) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }

    return nextResponse;
  } catch (error: any) {
    console.error('[VERIFY-ADMIN] Error verifying admin:', error);
    return NextResponse.json(
      {
        success: false,
        is_admin: false,
        message: error?.message || 'Admin verification check failed',
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const paramToken = url.searchParams.get('token') || url.searchParams.get('access_token') || undefined;
  const token = resolveBackendToken(req, paramToken);

  try {
    if (!token) {
      return NextResponse.json(
        {
          success: false,
          is_admin: false,
          message: 'User token is required for admin verification',
        },
        { status: 200 }
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };

    // Forward to upstream Lambda sending ONLY the token in Authorization header
    const response = await fetch(ADMIN_VERIFY_API_URL, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });

    const responseText = await response.text();
    let data: any = {};
    try {
      data = JSON.parse(responseText);
      if (data && typeof data.body === 'string') {
        data = JSON.parse(data.body);
      }
    } catch {
      data = { raw: responseText };
    }

    const isAdmin = Boolean(data?.is_admin === true || data?.isAdmin === true);

    return NextResponse.json({
      success: true,
      is_admin: isAdmin,
      email: data?.email || '',
      data,
    });
  } catch (error: any) {
    console.error('[VERIFY-ADMIN GET] Error:', error);
    return NextResponse.json(
      {
        success: false,
        is_admin: false,
        message: error?.message || 'Admin verification check failed',
      },
      { status: 500 }
    );
  }
}
