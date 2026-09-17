import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      aws_access_key,
      aws_secret_key,
      region,
      key_pair_name,
      user_name,
      codebuild_projects,
    } = body;

    if (
      !aws_access_key ||
      !aws_secret_key ||
      !region ||
      !key_pair_name ||
      !user_name ||
      !codebuild_projects?.length
    ) {
      return NextResponse.json(
        { success: false, message: 'All fields are required' },
        { status: 400 }
      );
    }

    const response = await fetch(
      'https://wkn4icbie8.execute-api.us-east-1.amazonaws.com/freelabs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'PROVISION',
          user_name,
          key_pair_name,
          region,
          aws_access_key,
          aws_secret_key,
          codebuild_projects,
        }),
      }
    );

    const responseText = await response.text();
    let data: unknown = responseText;

    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      // Preserve non-JSON upstream responses for diagnostics.
    }

    const upstreamMessage =
      typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : undefined;

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: upstreamMessage || 'Provisioning API request failed',
        },
        { status: response.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: 'Request sent successfully',
        data,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { success: false, message: 'Server error' },
      { status: 500 }
    );
  }
}
