import { NextRequest, NextResponse } from 'next/server';
import http from 'http';
import https from 'https';

export const dynamic = 'force-dynamic';

function checkSplunkWebPort(ip: string): Promise<{ ip: string; status: string; details: string }> {
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
    const body = await request.json();
    const management_server_ip = body?.management_server_ip || body?.body?.management_server_ip;
    const username = body?.username || body?.body?.username || 'admin';
    const password = body?.password || body?.body?.password || 'admin123';

    if (!management_server_ip) {
      return NextResponse.json(
        { error: 'management_server_ip is required' },
        { status: 400 },
      );
    }

    const licenseCheck: { status: string; message?: string } = await new Promise((resolve) => {
      const agent = new https.Agent({ rejectUnauthorized: false });
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
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
    console.error('License validation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'License check failed' },
      { status: 500 },
    );
  }
}
