import { NextRequest, NextResponse } from 'next/server';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { getSessionTenantId } from '@/lib/auth-session';

export async function GET(request: NextRequest) {
    try {
        // Verify user is authenticated
        await getSessionTenantId();

        const ec2Client = new EC2Client({ region: process.env.AWS_REGION || 'us-east-1' });
        const result = await ec2Client.send(new DescribeRegionsCommand({ AllRegions: true }));

        const regions = (result.Regions || [])
            .filter(r => r.RegionName)
            .map(r => ({
                value: r.RegionName!,
                label: r.RegionName!,
                endpoint: r.Endpoint,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        return NextResponse.json({ success: true, data: regions });
    } catch (error: unknown) {
        console.error('Error fetching AWS regions:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch AWS regions';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
