import { NextRequest, NextResponse } from 'next/server';
import { EC2Client, CreateKeyPairCommand } from '@aws-sdk/client-ec2';

export async function POST(req: NextRequest) {
  try {
    const { aws_access_key, aws_secret_key, region, key_pair_name } = await req.json();

    if (!aws_access_key || !aws_secret_key || !region || !key_pair_name) {
      return NextResponse.json({ success: false, message: 'All fields are required' }, 
      { status: 400 });
    }

    const ec2Client = new EC2Client({
      region,
      credentials: { accessKeyId: aws_access_key, secretAccessKey: aws_secret_key },
    });

    const createResponse = await ec2Client.send(new CreateKeyPairCommand({ KeyName: key_pair_name, KeyType: 'rsa' }));

    if (!createResponse.KeyMaterial) throw new Error('Failed to create key pair');

    return NextResponse.json({
      success: true,
      message: `Key pair "${key_pair_name}" created successfully`,
      keyMaterial: createResponse.KeyMaterial,
    });

  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ success: false, message: err.message || 'Key creation failed' }, { status: 500 });
  }
}
