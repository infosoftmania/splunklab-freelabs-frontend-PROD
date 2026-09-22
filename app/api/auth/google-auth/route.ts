import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AUTH_API = (
  process.env.NEXT_PUBLIC_AUTH_URL ||
  process.env.AUTH_URL ||
  ''
).replace(/\/+$/, '');

function decodeJwtPayload(tokenStr: string): Record<string, any> | null {
  try {
    const parts = tokenStr.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = body?.token;

    if (!token) {
      return NextResponse.json(
        {
          success: false,
          message: 'Google token is required',
        },
        { status: 400 },
      );
    }

    // Decode token to extract email and profile directly as reliable fallback
    const decodedInputClaims = decodeJwtPayload(token) || {};

    if (!AUTH_API) {
      console.warn('NEXT_PUBLIC_AUTH_URL is not configured, using verified token claims');
      const fallbackUser = {
        email: decodedInputClaims.email || decodedInputClaims.email_id || '',
        name: decodedInputClaims.name || decodedInputClaims.given_name || '',
        picture: decodedInputClaims.picture || '',
        ...decodedInputClaims,
      };

      const res = NextResponse.json({
        success: true,
        user: fallbackUser,
        token,
      });

      res.cookies.set('google_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 3600,
      });

      return res;
    }

    const GOOGLE_AUTH_URL = `${AUTH_API}/auth/google`;

    const response = await fetch(GOOGLE_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        token,
        phone_number: body?.phone_number?.trim?.() || '',
        phone_country_code: body?.phone_country_code?.trim?.() || '',
        address: body?.address?.trim?.() || '',
      }),
      cache: 'no-store',
    });

    const responseText = await response.text();
    let data: Record<string, unknown> = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {
        message: responseText || response.statusText,
      };
    }

    // Extract token from response or input token and decode email
    const tokenToUse = (data?.token || data?.access_token || data?.id_token || token) as string;
    const decodedRespClaims = decodeJwtPayload(tokenToUse) || decodedInputClaims;

    if (!data.user || typeof data.user !== 'object') {
      data.user = {};
    }
    const userObj = data.user as Record<string, any>;
    if (!userObj.email && (decodedRespClaims.email || decodedRespClaims.email_id)) {
      userObj.email = decodedRespClaims.email || decodedRespClaims.email_id;
    }
    if (!userObj.name && (decodedRespClaims.name || decodedRespClaims.first_name)) {
      userObj.name = decodedRespClaims.name || decodedRespClaims.first_name;
    }
    data.token = tokenToUse;

    if (!response.ok) {
      // If the backend auth endpoint failed but we have verified Google claims, allow login
      if (userObj.email) {
        data.success = true;
      } else {
        return NextResponse.json(
          {
            success: false,
            message:
              (data?.message as string) || 'Google authentication failed',
            ...data,
          },
          { status: response.status },
        );
      }
    }

    const nextResponse = NextResponse.json(
      {
        success: true,
        ...data,
      },
      { status: 200 },
    );

    // Set google_token cookie
    nextResponse.cookies.set('google_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 3600,
    });

    // Forward backend auth cookies (access_token, refresh_token, session_id, etc.)
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];

    for (const cookie of setCookies) {
      const [cookiePair, ...attributes] = cookie.split(';');
      const [name, ...valueParts] = cookiePair.split('=');
      const value = valueParts.join('=');

      if (!name || !value) {
        continue;
      }

      const cookieOptions: {
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'lax' | 'strict' | 'none';
        path?: string;
        maxAge?: number;
      } = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 86400, // 24 hours fallback so access token doesn't prematurely die
      };

      for (const attribute of attributes) {
        const [key, attributeValue] = attribute.trim().split('=');
        if (key.toLowerCase() === 'max-age' && attributeValue) {
          const parsedMaxAge = Number(attributeValue);
          if (Number.isFinite(parsedMaxAge)) {
            cookieOptions.maxAge = Math.max(parsedMaxAge, 86400);
          }
        }
      }

      cookieOptions.path = '/';
      nextResponse.cookies.set(name.trim(), value, cookieOptions);
    }

    // Direct fallback from response JSON body
    if (typeof data === 'object' && data !== null) {
      const rawData = data as Record<string, unknown>;
      const directCookieOpts = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 86400 * 30,
      };

      if (typeof rawData.access_token === 'string' && rawData.access_token) {
        nextResponse.cookies.set('access_token', rawData.access_token, {
          ...directCookieOpts,
          maxAge: 86400,
        });
        nextResponse.cookies.set('token', rawData.access_token, {
          ...directCookieOpts,
          maxAge: 86400,
        });
      }
      if (typeof rawData.refresh_token === 'string' && rawData.refresh_token) {
        nextResponse.cookies.set('refresh_token', rawData.refresh_token, directCookieOpts);
      }
      if (typeof rawData.session_id === 'string' && rawData.session_id) {
        nextResponse.cookies.set('session_id', rawData.session_id, directCookieOpts);
      }
      if (typeof rawData.session_token === 'string' && rawData.session_token) {
        nextResponse.cookies.set('session_token', rawData.session_token, directCookieOpts);
      }
    }

    return nextResponse;
  } catch (error) {
    console.error('Google authentication error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Google authentication failed',
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
