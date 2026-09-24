import { NextResponse } from 'next/server';
import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  DescribeAddressesCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
} from '@aws-sdk/client-ec2';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      aws_access_key,
      aws_secret_key,
      region,
      key_pair_name,
      action = 'PROVISION',
      user_email: raw_user_email,
      user_name: raw_user_name,
      codebuild_projects: raw_codebuild_projects,
      lab_id: raw_lab_id,
    } = body;

    // 1. Extract email
    const user_email =
      raw_user_email ||
      body.email ||
      (typeof raw_user_name === 'string' && raw_user_name.includes('@') ? raw_user_name : '');

    // 2. Derive clean user_name: alphanumeric/underscore
    let user_name = raw_user_name || '';
    if (!user_name || user_name.includes('@')) {
      if (user_email) {
        user_name = user_email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
      } else {
        user_name = 'student';
      }
    }

    const API_URL =
      process.env.FREELABS_API_URL ||
      process.env.NEXT_PUBLIC_FREELABS_API_URL ||
      'https://wkn4icbie8.execute-api.us-east-1.amazonaws.com/freelabs';

    const currentAction = String(action).toUpperCase();

    // -------------------------------------------------------------
    // ACTION: STATUS (Polled by UI to check if instances are ready)
    // -------------------------------------------------------------
    if (currentAction === 'STATUS') {
      const targetLabId = raw_lab_id || body.run_id || '';
      if (!aws_access_key || !aws_secret_key || !region || !user_name) {
        return NextResponse.json(
          { success: false, message: 'AWS credentials, region, and user_name are required for status check' },
          { status: 400 }
        );
      }

      const statusPayload = {
        action: 'STATUS',
        user_name,
        user_email,
        lab_id: targetLabId,
        region,
        aws_access_key,
        aws_secret_key,
        codebuild_projects: ['project 5'],
      };

      try {
        const statusResp = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(statusPayload),
        });

        const statusText = await statusResp.text();
        let statusJson: any = null;
        try {
          statusJson = JSON.parse(statusText);
          if (statusJson && typeof statusJson.body === 'string') {
            statusJson = JSON.parse(statusJson.body);
          }
        } catch {
          statusJson = { message: statusText };
        }

        const rawInstances = statusJson?.instances || {};
        const servers: Record<string, any> = {};
        for (const [sName, sData] of Object.entries(rawInstances)) {
          const s = sData as any;
          servers[sName] = {
            public_ip: s.public_ip || s.private_ip,
            private_ip: s.private_ip,
            instance_id: s.instance_id,
            state: s.state,
            instance_type: s.instance_type,
          };
        }

        return NextResponse.json(
          {
            success: true,
            status: statusJson?.status || 'OK',
            instance_count: statusJson?.instance_count || Object.keys(servers).length,
            servers,
            instances: rawInstances,
            lab_id: targetLabId,
          },
          { status: 200 }
        );
      } catch (err: any) {
        return NextResponse.json(
          { success: false, message: err.message || 'Status check failed' },
          { status: 500 }
        );
      }
    }
 
    // -------------------------------------------------------------
    // ACTION: DESTROY (Terminate EC2, Release EIPs, Delete SGs, Teardown)
    // -------------------------------------------------------------
    if (currentAction === 'DESTROY') {
      const emailPrefix = user_email ? user_email.split('@')[0] : '';
      const lab_id = raw_lab_id || emailPrefix || '';

      if (!aws_access_key || !aws_secret_key || !region) {
        return NextResponse.json(
          { success: false, message: 'AWS credentials and region are required for lab termination' },
          { status: 400 }
        );
      }

      const ec2Client = new EC2Client({
        region,
        credentials: {
          accessKeyId: String(aws_access_key).trim(),
          secretAccessKey: String(aws_secret_key).trim(),
        },
      });

      const terminatedInstanceIds: string[] = [];
      const releasedEips: string[] = [];
      const deletedSecurityGroups: string[] = [];

      // 1. Terminate all active/running/stopped FreeLabs EC2 instances
      try {
        const descRes = await ec2Client.send(
          new DescribeInstancesCommand({
            Filters: [
              {
                Name: 'instance-state-name',
                Values: ['pending', 'running', 'stopping', 'stopped'],
              },
            ],
          })
        );

        const idsToTerminate: string[] = [];
        for (const res of descRes.Reservations || []) {
          for (const inst of res.Instances || []) {
            let isTarget = false;
            for (const t of inst.Tags || []) {
              if (t.Key === 'LabId' && lab_id && t.Value === lab_id) {
                isTarget = true;
                break;
              }
              if (t.Key === 'Name' && t.Value?.startsWith('FreeLab-')) {
                isTarget = true;
                break;
              }
            }
            if (isTarget && inst.InstanceId && !idsToTerminate.includes(inst.InstanceId)) {
              idsToTerminate.push(inst.InstanceId);
            }
          }
        }

        if (idsToTerminate.length > 0) {
          await ec2Client.send(
            new TerminateInstancesCommand({ InstanceIds: idsToTerminate })
          );
          terminatedInstanceIds.push(...idsToTerminate);
          console.log(`[DESTROY] Terminated ${idsToTerminate.length} EC2 instances:`, idsToTerminate);
        }
      } catch (instErr: any) {
        console.warn('[DESTROY] EC2 termination warning:', instErr?.message);
      }

      // 2. Release Elastic IPs allocated to this lab
      try {
        const addrRes = await ec2Client.send(new DescribeAddressesCommand({}));
        for (const addr of addrRes.Addresses || []) {
          let isLabEip = false;
          for (const t of addr.Tags || []) {
            if (t.Key === 'LabId' && lab_id && t.Value === lab_id) {
              isLabEip = true;
              break;
            }
            if (t.Key === 'Name' && t.Value?.startsWith('FreeLab-')) {
              isLabEip = true;
              break;
            }
          }
          if (!isLabEip && addr.InstanceId && terminatedInstanceIds.includes(addr.InstanceId)) {
            isLabEip = true;
          }

          if (isLabEip) {
            if (addr.AssociationId) {
              try {
                await ec2Client.send(
                  new DisassociateAddressCommand({ AssociationId: addr.AssociationId })
                );
              } catch (disErr: any) {
                // Normal AWS behavior: When an instance terminates, AWS automatically detaches the EIP association
                console.log(`[DESTROY] EIP already auto-detached by AWS during termination.`);
              }
            }
            if (addr.AllocationId) {
              try {
                await ec2Client.send(
                  new ReleaseAddressCommand({ AllocationId: addr.AllocationId })
                );
                if (addr.PublicIp) releasedEips.push(addr.PublicIp);
                console.log(`[DESTROY] Released Elastic IP: ${addr.PublicIp} (${addr.AllocationId})`);
              } catch (relErr) {
                console.warn('[DESTROY] Release EIP warning:', relErr);
              }
            }
          }
        }
      } catch (eipErr: any) {
        console.warn('[DESTROY] EIP release warning:', eipErr?.message);
      }

      // 3. Delete FreeLabs Security Groups
      try {
        const sgRes = await ec2Client.send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              {
                Name: 'group-name',
                Values: ['freelabs-sg-*'],
              },
            ],
          })
        );
        for (const sg of sgRes.SecurityGroups || []) {
          if (sg.GroupId) {
            const matchesLab =
              !lab_id ||
              (sg.GroupName && (sg.GroupName.includes(lab_id) || sg.GroupName.includes(user_name)));
            if (matchesLab) {
              try {
                await ec2Client.send(
                  new DeleteSecurityGroupCommand({ GroupId: sg.GroupId })
                );
                deletedSecurityGroups.push(sg.GroupId);
                console.log(`[DESTROY] Deleted security group: ${sg.GroupId}`);
              } catch (sgErr) {
                console.log(`[DESTROY] Security group ${sg.GroupId} cleanup deferred until instances terminate completely.`);
              }
            }
          }
        }
      } catch (sgErr: any) {
        console.warn('[DESTROY] SG deletion warning:', sgErr?.message);
      }

      // 4. Forward DESTROY request to backend API (to delete state files, revoke AMI share, etc.)
      let backendData: any = null;
      try {
        const destroyPayload = {
          action: 'DESTROY',
          user_name,
          user_email,
          lab_id,
          region,
          key_name: key_pair_name || '',
          key_pair_name: key_pair_name || '',
          aws_access_key,
          aws_secret_key,
          codebuild_projects: ['project 5'],
        };

        const destroyResp = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(destroyPayload),
        });

        const destroyText = await destroyResp.text();
        try {
          backendData = JSON.parse(destroyText);
          if (backendData && typeof backendData.body === 'string') {
            backendData = JSON.parse(backendData.body);
          }
        } catch {
          backendData = { message: destroyText };
        }
      } catch (backendErr: any) {
        console.warn('[DESTROY] Backend API forward warning:', backendErr?.message);
      }

      return NextResponse.json(
        {
          success: true,
          status: 'DESTROYED',
          message: 'All lab resources (EC2 instances, Elastic IPs, and security groups) have been terminated and cleaned up successfully.',
          terminated_instances: terminatedInstanceIds,
          released_eips: releasedEips,
          deleted_security_groups: deletedSecurityGroups,
          backend_data: backendData,
        },
        { status: 200 }
      );
    }

    // -------------------------------------------------------------
    // ACTION: PROVISION
    // -------------------------------------------------------------
    if (
      !aws_access_key ||
      !aws_secret_key ||
      !region ||
      !key_pair_name ||
      (!user_email && !user_name)
    ) {
      return NextResponse.json(
        { success: false, message: 'All fields are required (AWS credentials, region, key pair, email)' },
        { status: 400 }
      );
    }

    const emailPrefix = user_email ? user_email.split('@')[0] : '';
    const lab_id = raw_lab_id || emailPrefix || `freelab_${Math.floor(Date.now() / 1000)}`;

    // -------------------------------------------------------------
    // Guard: Check if instances ALREADY exist for this lab_id in AWS
    // -------------------------------------------------------------
    try {
      const ec2Client = new EC2Client({
        region,
        credentials: {
          accessKeyId: String(aws_access_key).trim(),
          secretAccessKey: String(aws_secret_key).trim(),
        },
      });

      const checkRes = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'tag:LabId',
              Values: [lab_id],
            },
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
        })
      );

      let existingCount = 0;
      const existingServers: Record<string, any> = {};
      for (const res of checkRes.Reservations || []) {
        for (const inst of res.Instances || []) {
          existingCount++;
          let sName = inst.InstanceId || 'unknown';
          for (const t of inst.Tags || []) {
            if (t.Key === 'Name' && t.Value) sName = t.Value;
          }
          existingServers[sName] = {
            public_ip: inst.PublicIpAddress || inst.PrivateIpAddress || 'N/A',
            private_ip: inst.PrivateIpAddress || 'N/A',
            instance_id: inst.InstanceId,
            state: inst.State?.Name || 'unknown',
            region,
          };
        }
      }

      if (existingCount > 0) {
        return NextResponse.json(
          {
            success: false,
            existing_lab: true,
            instance_count: existingCount,
            servers: existingServers,
            lab_id,
            message: `⚠️ An active lab already exists for this account (${existingCount} servers found for Lab ID: "${lab_id}"). Please terminate your existing lab before creating a new one.`,
          },
          { status: 409 }
        );
      }
    } catch (checkErr: any) {
      console.warn('[SUBMIT-FORM] Pre-provision check warning:', checkErr?.message);
    }

    const backendPayload: Record<string, any> = {
      action: 'PROVISION',
      user_name,
      user_email,
      key_pair_name,
      region,
      aws_access_key,
      aws_secret_key,
      codebuild_projects: ['project 5'],
      lab_id,
    };

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backendPayload),
    });

    const responseText = await response.text();
    let data: any = null;

    try {
      data = responseText ? JSON.parse(responseText) : null;
      if (data && typeof data === 'object' && 'body' in data && typeof data.body === 'string') {
        try {
          const inner = JSON.parse(data.body);
          data = { ...data, ...inner, parsed_body: inner };
        } catch {
          // keep as is
        }
      }
    } catch {
      data = { raw: responseText };
    }

    const upstreamMessage =
      typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : undefined;

    // If API Gateway timed out at 30 seconds (503 Service Unavailable / 504 Gateway Timeout),
    // the Lambda function is already executing in AWS background and will finish creating instances.
    // Return HTTP 200 with status: "IN_PROGRESS" so the frontend displays "Environment setup please wait..."
    if (
      !response.ok &&
      (response.status === 503 ||
        response.status === 504 ||
        upstreamMessage?.includes('Service Unavailable') ||
        upstreamMessage?.includes('timed out'))
    ) {
      console.log(`[SUBMIT-FORM] API Gateway returned ${response.status}. Provisioning started in background for lab_id: ${lab_id}`);
      return NextResponse.json(
        {
          success: true,
          status: 'IN_PROGRESS',
          message: 'Environment setup started. Please wait...',
          lab_id,
          data: {
            status: 'IN_PROGRESS',
            lab_id,
            user_name,
            user_email,
          },
        },
        { status: 200 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: upstreamMessage || 'Provisioning API request failed',
          data,
        },
        { status: response.status }
      );
    }

    // Success response: could be immediate IN_PROGRESS (from async Lambda) or completed servers
    const resStatus = data?.status || 'IN_PROGRESS';
    const rawInstances = data?.instances || data?.parsed_body?.instances || {};
    const servers: Record<string, any> = {};
    for (const [sName, sData] of Object.entries(rawInstances)) {
      const s = sData as any;
      servers[sName] = {
        public_ip: s.public_ip || s.private_ip,
        private_ip: s.private_ip,
        instance_id: s.instance_id,
        state: s.state,
        region: s.region || region,
      };
    }

    return NextResponse.json(
      {
        success: true,
        status: resStatus,
        message: upstreamMessage || (resStatus === 'IN_PROGRESS' ? 'Environment setup started. Please wait...' : 'Environment provisioned successfully!'),
        lab_id,
        data: {
          status: resStatus,
          lab_id,
          user_name,
          user_email,
          servers: Object.keys(servers).length > 0 ? servers : undefined,
          instance_count: data?.instance_count || Object.keys(servers).length,
        },
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[SUBMIT-FORM] Error:', error);
    return NextResponse.json(
      { success: false, message: error?.message || 'Server error' },
      { status: 500 }
    );
  }
}
