import { NextRequest, NextResponse } from 'next/server';
import http from 'http';

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
    const publicIps: string[] = body?.public_ips || body?.body?.public_ips || [];

    if (!Array.isArray(publicIps) || publicIps.length === 0) {
      return NextResponse.json({ error: 'public_ips array is required' }, { status: 400 });
    }

    const results = await Promise.all(publicIps.map((ip) => checkSplunkWebPort(ip)));
    return NextResponse.json({ results }, { status: 200 });
  } catch (error: unknown) {
    console.error('Splunk port validation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Port validation failed' },
      { status: 500 },
    );
  }
}
