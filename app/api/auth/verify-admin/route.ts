import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ADMIN_VERIFY_API_URL =
  process.env.ADMIN_VERIFY_API_URL ||
  'https://u8eyhd99pc.execute-api.us-east-1.amazonaws.com/verify-admin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get('authorization') || '';
    const token =
      body?.token ||
      (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '') ||
      req.cookies.get('google_token')?.value ||
      '';

    const email = body?.email || '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const targetUrl = new URL(ADMIN_VERIFY_API_URL);
    if (email) {
      targetUrl.searchParams.set('email', email);
    }

    const response = await fetch(targetUrl.toString(), {
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
      email: email || data?.email || '',
      data,
    });
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
  const email = url.searchParams.get('email') || '';
  const authHeader = req.headers.get('authorization') || '';
  const token =
    (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '') ||
    req.cookies.get('google_token')?.value ||
    '';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const targetUrl = new URL(ADMIN_VERIFY_API_URL);
    if (email) {
      targetUrl.searchParams.set('email', email);
    }

    const response = await fetch(targetUrl.toString(), {
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
      email,
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
