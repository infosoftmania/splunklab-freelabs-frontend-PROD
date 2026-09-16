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

    const BASE_API_URL = process.env.AWS_LABS_API_URL;

    if (!BASE_API_URL) {
      return NextResponse.json(
        { success: false, message: 'AWS_LABS_API_URL is not configured' },
        { status: 500 }
      );
    }

    const API_URL = `${BASE_API_URL}/free-labs`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: data?.message || 'Upstream API failed',
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
