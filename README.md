This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
# free-labs



my-next-app/
├─ app/
│  └─ page.tsx                  # Main page that renders <AwsForm />
├─ api/
│  ├─ validate-aws.ts           # Validate AWS credentials via AWS SDK
│  └─ submit-form.ts            # Submit form data / trigger Terraform / CodeBuild
├─ components/
│  ├─ AwsForm.tsx               # Main form component
│  └─ InputField.tsx            # Reusable input field component
├─ package.json
├─ tsconfig.json
└─ next.config.js


HTTPS is enabled

You don’t log request bodies

You don’t store keys







### free-tier  and credits validate code 

import { NextRequest, NextResponse } from 'next/server';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';

export async function POST(req: NextRequest) {
  try {
    const { aws_access_key, aws_secret_key } = await req.json();

    // 1️⃣ Required fields
    if (!aws_access_key || !aws_secret_key) {
      return NextResponse.json(
        {
          awsValid: false,
          paidAccount: false,
          message: 'AWS Access Key and Secret Key are required',
        },
        { status: 400 }
      );
    }

    const credentials = {
      accessKeyId: aws_access_key,
      secretAccessKey: aws_secret_key,
    };

    // 2️⃣ Validate AWS credentials
    const stsClient = new STSClient({ credentials });

    try {
      await stsClient.send(new GetCallerIdentityCommand({}));
    } catch {
      return NextResponse.json(
        {
          awsValid: false,
          paidAccount: false,
          message: 'Invalid AWS credentials',
        },
        { status: 401 }
      );
    }

    // 3️⃣ Check billing (STRICT PAID ONLY)
    const ceClient = new CostExplorerClient({
      credentials,
      region: 'us-east-1', // Cost Explorer is global
    });

    try {
      const result = await ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: {
            Start: '2024-01-01',
            End: '2024-01-02',
          },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
        })
      );

      const amount =
        result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? '0';

      // ✅ Paid account (real spend)
      if (parseFloat(amount) > 0) {
        return NextResponse.json({
          awsValid: true,
          paidAccount: true,
          message: 'Paid AWS account verified',
        });
      }

      // ❌ Free Tier (no spend)
      return NextResponse.json(
        {
          awsValid: false,
          paidAccount: false,
          message: 'Free Tier AWS accounts are not allowed',
        },
        { status: 403 }
      );

    } catch {
      // ❌ No billing access → treat as Free Tier / restricted
      return NextResponse.json(
        {
          awsValid: false,
          paidAccount: false,
          message: 'Billing access not enabled. Paid account required',
        },
        { status: 403 }
      );
    }

  } catch (err: any) {
    console.error('AWS validation error:', err);

    return NextResponse.json(
      {
        awsValid: false,
        paidAccount: false,
        message: 'AWS validation failed',
      },
      { status: 500 }
    );
  }
}
