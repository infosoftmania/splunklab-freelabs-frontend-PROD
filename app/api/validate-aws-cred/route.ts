import { NextRequest, NextResponse } from 'next/server';
import { extractEmailFromToken, normalizeAwsValidationResponse } from '@/lib/aws-validation';
import { getValidAccessToken, getCoordinatedRefresh } from '@/lib/authenticated-backend-fetch';

export const dynamic = 'force-dynamic';

const AWS_CRED_VALIDATE_API_URL = (
  process.env.AWS_CRED_VALIDATE_API_URL ||
  'https://u8eyhd99pc.execute-api.us-east-1.amazonaws.com/validate-aws-cred'
).replace(/\/default\/validate-aws-cred$/, '/validate-aws-cred');

function resolveBackendToken(req: NextRequest, bodyToken?: string): string {
  const cookieAccessToken = req.cookies.get('access_token')?.value;
  const rawAuth = req.headers.get('authorization') || req.headers.get('token') || '';
  const headerToken = rawAuth.replace(/^Bearer\s+/i, '').trim();

  if (cookieAccessToken) return cookieAccessToken;
  if (bodyToken) return bodyToken;
  if (headerToken) return headerToken;
  return req.cookies.get('google_token')?.value || '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { aws_access_key, aws_secret_key, region = 'us-east-1', is_admin, mode } = body;

    // 1. Basic validation
    if (!aws_access_key || !aws_secret_key) {
      return NextResponse.json(
        {
          success: false,
          valid_account: false,
          has_required_vcpu: false,
          available_vcpus: 0,
          message: 'AWS Access Key and Secret Key are required.',
        },
        { status: 400 }
      );
    }

    const trimmedKey = String(aws_access_key).trim();
    const trimmedSecret = String(aws_secret_key).trim();
    const targetRegion = region || 'us-east-1';
    let isAdmin = Boolean(is_admin === true || mode === 'admin');

    // 2. Resolve token & user email (with automatic proactive refresh if expired)
    const rawProvidedToken = resolveBackendToken(req, body?.token || body?.access_token);
    const { token: validToken, setCookies } = await getValidAccessToken(req, rawProvidedToken);
    let cleanToken = (validToken || '').replace(/^Bearer\s+/i, '').trim();

    // If not explicitly passed as admin, verify admin status using token via verify-admin
    if (!isAdmin && cleanToken) {
      try {
        const verifyUrl =
          process.env.ADMIN_VERIFY_API_URL ||
          'https://u8eyhd99pc.execute-api.us-east-1.amazonaws.com/verify-admin';
        const verifyRes = await fetch(verifyUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cleanToken}`,
          },
          cache: 'no-store',
        });
        const verifyData = await verifyRes.json();
        if (verifyData?.is_admin === true || verifyData?.isAdmin === true) {
          isAdmin = true;
        }
      } catch (adminErr) {
        console.warn('[VALIDATE-AWS-CRED] Admin verification lookup warning:', adminErr);
      }
    }

    let userEmail = body?.user_email || body?.email || '';
    if (!userEmail && cleanToken) {
      userEmail = extractEmailFromToken(cleanToken);
    }

    // 3. Build upstream request
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cleanToken) {
      upstreamHeaders['Authorization'] = `Bearer ${cleanToken}`;
      upstreamHeaders['token'] = cleanToken;
    }

    const upstreamPayload: Record<string, any> = {
      ...body,
      aws_access_key: trimmedKey,
      aws_secret_key: trimmedSecret,
      aws_access_key_id: trimmedKey,
      aws_secret_access_key: trimmedSecret,
      access_key: trimmedKey,
      secret_key: trimmedSecret,
      access_key_id: trimmedKey,
      secret_access_key: trimmedSecret,
      region: targetRegion,
      target_region: targetRegion,
      user_email: userEmail,
      email: userEmail,
      is_admin: isAdmin,
      mode: isAdmin ? 'admin' : (mode || 'student'),
      token: cleanToken,
    };

    console.log(
      `[VALIDATE-AWS-CRED] Forwarding validation request to upstream API: ${AWS_CRED_VALIDATE_API_URL}`
    );

    // 4. Call upstream API
    let response = await fetch(AWS_CRED_VALIDATE_API_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload),
    });

    let responseText = await response.text();
    let rawData: any = null;

    try {
      rawData = responseText ? JSON.parse(responseText) : {};
      if (rawData && typeof rawData === 'object' && typeof rawData.body === 'string') {
        try {
          const inner = JSON.parse(rawData.body);
          rawData = { ...rawData, ...inner };
        } catch {
          // keep as is
        }
      }
    } catch {
      rawData = { message: responseText };
    }

    // If upstream indicated token expired/unauthorized, perform refresh using refresh_token and retry
    const isTokenExpired =
      response.status === 401 ||
      (typeof rawData?.message === 'string' &&
        (rawData.message.toLowerCase().includes('expired') ||
          rawData.message.toLowerCase().includes('unauthorized') ||
          rawData.message.toLowerCase().includes('token')));

    if (isTokenExpired) {
      const refreshToken = req.cookies.get('refresh_token')?.value;
      const sessionId =
        req.cookies.get('session_id')?.value ||
        req.cookies.get('session_token')?.value;

      if (refreshToken && sessionId) {
        console.log('[VALIDATE-AWS-CRED] Upstream indicated token expired, executing refresh...');
        const refreshResult = await getCoordinatedRefresh(refreshToken, sessionId);
        if (refreshResult.accessToken) {
          cleanToken = refreshResult.accessToken;
          upstreamHeaders['Authorization'] = `Bearer ${cleanToken}`;
          upstreamHeaders['token'] = cleanToken;
          upstreamPayload.token = cleanToken;

          response = await fetch(AWS_CRED_VALIDATE_API_URL, {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(upstreamPayload),
          });

          responseText = await response.text();
          try {
            rawData = responseText ? JSON.parse(responseText) : {};
            if (rawData && typeof rawData === 'object' && typeof rawData.body === 'string') {
              try {
                const inner = JSON.parse(rawData.body);
                rawData = { ...rawData, ...inner };
              } catch {}
            }
          } catch {
            rawData = { message: responseText };
          }

          for (const c of refreshResult.setCookies) {
            setCookies.push(c);
          }
        }
      }
    }

    // 5. Clean passthrough of upstream API response, preserving admin role
    const responsePayload = {
      ...rawData,
      is_admin: isAdmin,
      mode: isAdmin ? 'admin' : (rawData?.mode || 'student'),
    };

    console.log(
      `[VALIDATE-AWS-CRED] Upstream API response [${response.status}], success: ${responsePayload.success}, message: ${responsePayload.message}`
    );

    const nextResponse = NextResponse.json(responsePayload, { status: response.status });
    for (const cookie of setCookies) {
      nextResponse.headers.append('Set-Cookie', cookie);
    }
    return nextResponse;
  } catch (error: any) {
    console.error('[VALIDATE-AWS-CRED] Unexpected error calling validation API:', error);
    return NextResponse.json(
      {
        success: false,
        valid_account: false,
        has_required_vcpu: false,
        available_vcpus: 0,
        message: error?.message || 'Error communicating with AWS validation API.',
      },
      { status: 500 }
    );
  }
}
