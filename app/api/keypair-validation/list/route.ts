import { NextRequest, NextResponse } from 'next/server';
import { EC2Client, DescribeKeyPairsCommand } from '@aws-sdk/client-ec2';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { aws_access_key, aws_secret_key, region } = await req.json();

    if (!aws_access_key || !aws_secret_key || !region) {
      return NextResponse.json(
        {
          success: false,
          keyPairs: [],
          message: 'AWS credentials and region are required',
        },
        { status: 400 },
      );
    }

    const ec2Client = new EC2Client({
      region,
      credentials: {
        accessKeyId: aws_access_key,
        secretAccessKey: aws_secret_key,
      },
    });

    try {
      const data = await ec2Client.send(new DescribeKeyPairsCommand({}));
      const keyPairs = data.KeyPairs?.map((kp) => kp.KeyName) || [];

      return NextResponse.json({
        success: true,
        keyPairs,
      });
    } catch (err: any) {
      console.error('Error fetching key pairs:', err);
      return NextResponse.json(
        {
          success: false,
          keyPairs: [],
          message: err.message || 'Failed to fetch key pairs',
        },
        { status: 500 },
      );
    }
  } catch (err: any) {
    console.error('Server error:', err);
    return NextResponse.json(
      {
        success: false,
        keyPairs: [],
        message: err.message || 'Server error',
      },
      { status: 500 },
    );
  }
}
