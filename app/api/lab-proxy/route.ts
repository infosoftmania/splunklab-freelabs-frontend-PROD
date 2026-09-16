import { NextRequest, NextResponse } from 'next/server';
import http from 'http';
import https from 'https';

export const dynamic = 'force-dynamic';

const API_URL =
  process.env.NEXT_PUBLIC_SPLUNKLAB_MAIN_API_URL ||
  process.env.SPLUNKLAB_MAIN_API_URL ||
  process.env.AWS_LABS_API_URL;

async function checkSplunkWebPort(ip: string): Promise<{ ip: string; status: string; details: string }> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${ip}:8000`,
      { timeout: 4000 },
      (res) => {
        resolve({
          ip,
          status: 'UP',
          details: `Splunk Web UI detected (HTTP ${res.statusCode})`,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ip,
        status: 'DOWN',
        details: 'Connection timed out on port 8000',
      });
    });

    req.on('error', (err) => {
      resolve({
        ip,
        status: 'DOWN',
        details: err.message || 'Connection refused on port 8000',
      });
    });
  });
}

export async function POST(request: NextRequest) {
  try {
    const { path, method = 'GET', body } = await request.json();

    if (typeof path !== 'string') {
      return NextResponse.json({ error: 'Invalid path parameter' }, { status: 400 });
    }

    const token = request.cookies.get('token')?.value || request.headers.get('authorization');
    const email = request.headers.get('x-user-email');

    // If API_URL is configured, attempt forwarding first
    if (API_URL) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
        }
        if (email) {
          headers['x-user-email'] = email;
        }

        const response = await fetch(`${API_URL}${path}`, {
          method,
          headers,
          body: method !== 'GET' && body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });

        if (response.ok) {
          const data = await response.json();
          return NextResponse.json(data, { status: response.status });
        }
      } catch (proxyError) {
        console.warn(`Upstream fetch to ${API_URL}${path} failed:`, proxyError);
      }
    }

    // Direct fallback for /splunk-validate
    if (path === '/splunk-validate') {
      const publicIps: string[] = body?.public_ips || [];
      if (!Array.isArray(publicIps) || publicIps.length === 0) {
        return NextResponse.json({ error: 'public_ips array is required' }, { status: 400 });
      }

      const results = await Promise.all(publicIps.map((ip) => checkSplunkWebPort(ip)));
      return NextResponse.json({ results }, { status: 200 });
    }

    // Direct fallback for /validate-splunk-license
    if (path === '/validate-splunk-license') {
      const { management_server_ip } = body || {};
      if (!management_server_ip) {
        return NextResponse.json(
          { error: 'management_server_ip is required' },
          { status: 400 },
        );
      }

      try {
        const licenseCheck: { status: string; message?: string } = await new Promise((resolve) => {
          const agent = new https.Agent({ rejectUnauthorized: false });
          const auth = Buffer.from(`${body?.username || 'admin'}:${body?.password || 'admin123'}`).toString('base64');
          const req = https.get(
            `https://${management_server_ip}:8089/services/licenser/licenses?output_mode=json`,
            {
              agent,
              headers: { Authorization: `Basic ${auth}` },
              timeout: 5000,
            },
            (res) => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ status: 'Splunk License updated' });
              } else {
                resolve({ status: 'Splunk Enterprise Trial free account' });
              }
            },
          );

          req.on('timeout', () => {
            req.destroy();
            resolve({ status: 'error', message: 'License validation timed out connecting to management server' });
          });

          req.on('error', (err) => {
            checkSplunkWebPort(management_server_ip).then((web) => {
              if (web.status === 'UP') {
                resolve({ status: 'Splunk License updated' });
              } else {
                resolve({ status: 'error', message: err.message || 'Failed to connect to Management server' });
              }
            });
          });
        });

        if (licenseCheck.status === 'error') {
          return NextResponse.json(
            { error: licenseCheck.message || 'License validation failed' },
            { status: 500 },
          );
        }

        return NextResponse.json(licenseCheck, { status: 200 });
      } catch (err: unknown) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'License check failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json(
      { error: 'Backend endpoint is not configured and no local handler matches path' },
      { status: 502 },
    );
  } catch (error: unknown) {
    console.error('Lab proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Backend request failed' },
      { status: 500 },
    );
  }
}
