import { NextResponse } from 'next/server';
import {
    generateOnboardingTemplate,
    generateOnboardingYaml,
    ONBOARDING_TEMPLATE_VERSION,
    type OnboardingTemplateOptions,
} from '@/lib/cf-template-generator';
import { env } from '@/env';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Account' },
    POST: { action: 'read', subject: 'Account' },
};

/**
 * Spot Guard options for the generated template.
 *
 * The hub bus ARN is plumbed from the Pulumi output via SPOT_GUARD_BUS_ARN rather than
 * reconstructed from parts: appName differs per stack (nucleus-cloud-ops vs
 * stx-nucleus-ops-sbx), so a hardcoded bus name would be silently wrong on sbx. When the
 * env var is absent (a stack that has not opted in) enableSpotAutomation is forced off,
 * so we can never hand a customer a template pointing at a bus that does not exist.
 */
function spotGuardOptions(requested: boolean): OnboardingTemplateOptions {
    const hubEventBusArn = env.SPOT_GUARD_BUS_ARN;
    if (requested && !hubEventBusArn) {
        console.warn(
            'API - accounts/template - Spot automation requested but SPOT_GUARD_BUS_ARN is unset; emitting template with it disabled',
        );
    }
    return {
        enableSpotAutomation: requested && Boolean(hubEventBusArn),
        hubEventBusArn,
    };
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const targetAccountId = searchParams.get('targetAccountId') || undefined;
        const accountName = searchParams.get('accountName') || undefined;

        // In a real app, these would come from config or the current user's organization context
        const hubAccountId = env.NEXT_PUBLIC_HUB_ACCOUNT_ID || env.HUB_ACCOUNT_ID || '044656767899';

        // Generate a random external ID for security (should be persisted in session or DB in real implementation)
        const externalId = 'nucleus-' + Math.random().toString(36).substring(2, 15);

        // Generate the suggested cross-account role ARN
        const suggestedRoleArn = targetAccountId
            ? `arn:aws:iam::${targetAccountId}:role/NucleusAccess-${hubAccountId}`
            : undefined;

        const opts = spotGuardOptions(searchParams.get('enableSpotAutomation') === 'true');
        const template = generateOnboardingTemplate(hubAccountId, externalId, targetAccountId, accountName, opts);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, targetAccountId, accountName, opts);

        return NextResponse.json({
            template,
            templateYaml,
            externalId,
            hubAccountId,
            suggestedRoleArn,
            templateVersion: ONBOARDING_TEMPLATE_VERSION,
            spotAutomationEnabled: opts.enableSpotAutomation,
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({ error: 'Failed to generate template' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { accountId, accountName, externalId: providedExternalId, enableSpotAutomation } = body;

        const hubAccountId = env.NEXT_PUBLIC_HUB_ACCOUNT_ID || env.HUB_ACCOUNT_ID || '044656767899';

        // Use provided External ID (for edits) or generate new one (for creates)
        const externalId = providedExternalId || 'nucleus-' + Math.random().toString(36).substring(2, 15);

        // Generate the suggested cross-account role ARN
        const suggestedRoleArn = accountId
            ? `arn:aws:iam::${accountId}:role/NucleusAccess-${hubAccountId}`
            : undefined;

        const opts = spotGuardOptions(enableSpotAutomation === true);
        const template = generateOnboardingTemplate(hubAccountId, externalId, accountId, accountName, opts);
        const templateYaml = generateOnboardingYaml(hubAccountId, externalId, accountId, accountName, opts);

        return NextResponse.json({
            success: true,
            template,
            templateYaml,
            externalId,
            hubAccountId,
            suggestedRoleArn,
            templateVersion: ONBOARDING_TEMPLATE_VERSION,
            spotAutomationEnabled: opts.enableSpotAutomation,
        });
    } catch (error) {
        console.error('Error generating template:', error);
        return NextResponse.json({
            success: false,
            error: 'Failed to generate template'
        }, { status: 500 });
    }
}
