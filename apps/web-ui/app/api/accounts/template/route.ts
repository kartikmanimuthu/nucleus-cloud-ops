import { NextResponse } from 'next/server';
import { generateOnboardingTemplate, generateOnboardingYaml } from '@/lib/cf-template-generator';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const targetAccountId = searchParams.get('targetAccountId') || undefined;
        const accountName = searchParams.get('accountName') || undefined;

        // In a real app, these would come from config or the current user's organization context
        const hubAccountId = process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID || process.env.HUB_ACCOUNT_ID || '044656767899';

        // Generate a random external ID for security (should be persisted in session or DB in real implementation)
        const externalId = 'nucleus-' + Math.random().toString(36).substring(2, 15);

        // Generate the suggested cross-account role ARN
        const suggestedRoleArn = targetAccountId
            ? `arn:aws:iam::${targetAccountId}:role/NucleusAccess-${hubAccountId}`
            : undefined;

        const template = generateOnboardingTemplate(hubAccountId, externalId, targetAccountId, accountName);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, targetAccountId, accountName);

        return NextResponse.json({
            template,
            templateYaml,
            externalId,
            hubAccountId,
            suggestedRoleArn,
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({ error: 'Failed to generate template' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { accountId, accountName, externalId: providedExternalId } = body;

        const hubAccountId = process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID || process.env.HUB_ACCOUNT_ID || '044656767899';

        // Use provided External ID (for edits) or generate new one (for creates)
        const externalId = providedExternalId || 'nucleus-' + Math.random().toString(36).substring(2, 15);

        // Generate the suggested cross-account role ARN
        const suggestedRoleArn = accountId
            ? `arn:aws:iam::${accountId}:role/NucleusAccess-${hubAccountId}`
            : undefined;

        const template = generateOnboardingTemplate(hubAccountId, externalId, accountId, accountName);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, accountId, accountName);

        return NextResponse.json({
            success: true,
            template,
            templateYaml,
            externalId,
            hubAccountId,
            suggestedRoleArn,
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({
            success: false,
            error: 'Failed to generate template'
        }, { status: 500 });
    }
}
