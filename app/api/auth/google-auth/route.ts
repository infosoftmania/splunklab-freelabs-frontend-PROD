import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AUTH_API = (
  process.env.NEXT_PUBLIC_AUTH_URL ||
  process.env.AUTH_URL ||
  ''
).replace(/\/+$/, '');

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

    if (!AUTH_API) {
      console.error('NEXT_PUBLIC_AUTH_URL is not configured');
      return NextResponse.json(
        {
          success: false,
          message: 'Authentication service is not configured',
        },
        { status: 500 },
      );
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

    if (!response.ok) {
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

    const nextResponse = NextResponse.json(
      {
        success: true,
        ...data,
      },
      { status: response.status },
    );

    // Set google_token cookie
    nextResponse.cookies.set('google_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
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
      };

      for (const attribute of attributes) {
        const [key, attributeValue] = attribute.trim().split('=');
        if (key.toLowerCase() === 'max-age' && attributeValue) {
          const parsedMaxAge = Number(attributeValue);
          if (Number.isFinite(parsedMaxAge)) {
            cookieOptions.maxAge = parsedMaxAge;
          }
        }
      }

      cookieOptions.path = '/';
      nextResponse.cookies.set(name.trim(), value, cookieOptions);
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
