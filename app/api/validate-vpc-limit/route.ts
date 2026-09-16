import { NextResponse } from 'next/server';
import { EC2Client, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';

export async function POST(req: Request) {
  try {
    const { aws_access_key, aws_secret_key, region, requiredVpcs } = await req.json();

    if (!aws_access_key || !aws_secret_key || !region || !requiredVpcs) {
      return NextResponse.json(
        { success: false, message: 'Missing parameters' },
        { status: 400 }
      );
    }

    // ---------------------
    // AWS Credentials
    // ---------------------
    const credentials = {
      accessKeyId: aws_access_key,
      secretAccessKey: aws_secret_key,
    };

    const ec2Client = new EC2Client({ region, credentials });
    const quotasClient = new ServiceQuotasClient({ region, credentials });

    // ---------------------
    // 1️⃣ Get current VPCs in the region
    // ---------------------
    const vpcsResponse = await ec2Client.send(new DescribeVpcsCommand({}));
    const currentVpcCount = vpcsResponse.Vpcs?.length ?? 0;

    // ---------------------
    // 2️⃣ Get VPC quota limit
    // ---------------------
    const quotaResponse = await quotasClient.send(
  new GetServiceQuotaCommand({
    ServiceCode: 'vpc',         // Use lowercase 'vpc' instead of 'ec2'
    QuotaCode: 'L-F678F1CE',    // VPC quota code
  })
);

// Access the value safely
const vpcLimit = quotaResponse.Quota?.Value ?? 0;


    // ---------------------
    // 3️⃣ Compare required VPCs with available
    // ---------------------
    if (currentVpcCount + requiredVpcs > vpcLimit) {
      return NextResponse.json({
        success: true,
        allowed: false,
        currentVpcCount,
        vpcLimit,
        requiredVpcs,
        message: `Not enough VPC slots: ${currentVpcCount} used, ${vpcLimit} total, need ${requiredVpcs}`,
      });
    }

    // ✅ Enough VPC slots
    return NextResponse.json({
      success: true,
      allowed: true,
      currentVpcCount,
      vpcLimit,
      requiredVpcs,
      available: vpcLimit - currentVpcCount,
    });

  } catch (error: any) {
    console.error(error);
    return NextResponse.json(
      { success: false, message: error.message || 'Server error' },
      { status: 500 }
    );
  }
}
