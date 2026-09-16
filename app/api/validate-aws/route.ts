import { NextRequest, NextResponse } from 'next/server';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export async function POST(req: NextRequest) {
  try {
    const { aws_access_key, aws_secret_key } = await req.json();

    // 1️⃣ Required fields check
    if (!aws_access_key || !aws_secret_key) {
      return NextResponse.json(
        {
          awsValid: false,
          message: 'AWS Access Key and Secret Key are required',
        },
        { status: 400 }
      );
    }

    // 2️⃣ Validate AWS credentials using STS
    const stsClient = new STSClient({
      credentials: {
        accessKeyId: aws_access_key,
        secretAccessKey: aws_secret_key,
      },
    });

    try {
      await stsClient.send(new GetCallerIdentityCommand({}));
    } catch {
      return NextResponse.json(
        {
          awsValid: false,
          message: 'Invalid AWS credentials',
        },
        { status: 401 }
      );
    }

    // ✅ Credentials are valid
    return NextResponse.json({
      awsValid: true,
      message: 'AWS credentials are valid',
    });

  } catch (err: any) {
    console.error('AWS validation error:', err);

    return NextResponse.json(
      {
        awsValid: false,
        message: err.message || 'AWS validation failed',
      },
      { status: 500 }
    );
  }
}
