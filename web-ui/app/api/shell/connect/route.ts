import { NextRequest, NextResponse } from 'next/server';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { ShellSessionService } from '@/lib/shell-session-service';
import { AccountService } from '@/lib/account-service';

const SHELL_SERVER_HOST = process.env.SHELL_SERVER_HOST ?? 'localhost:3001';
const SESSION_DURATION_SECONDS = 3600; // 1 hour

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'CloudShell');
    if (authError) return authError;

    try {
        console.log('API - POST /api/shell/connect - Requesting shell connection');
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const body = await request.json().catch(() => ({}));

        const { sessionId, accountId, region = 'us-east-1' } = body as {
            sessionId?: string;
            accountId?: string;
            region?: string;
        };

        if (!sessionId) {
            return NextResponse.json({ success: false, error: 'sessionId is required' }, { status: 400 });
        }

        // Verify session belongs to this user
        const session = await ShellSessionService.getSession(tenantId, sessionId);
        if (!session || session.userId !== userId) {
            return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
        }

        let creds: {
            accessKeyId: string;
            secretAccessKey: string;
            sessionToken: string;
            region: string;
            expiresAt: string;
        } | undefined;

        // If accountId provided, try to assume role for that account
        if (accountId) {
            const account = await AccountService.getAccount(accountId, tenantId);
            if (!account) {
                return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
            }

            try {
                const stsClient = new STSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
                const assumed = await stsClient.send(new AssumeRoleCommand({
                    RoleArn: account.roleArn,
                    RoleSessionName: `NucleusShell-${userId.substring(0, 16)}`,
                    ExternalId: account.externalId,
                    DurationSeconds: SESSION_DURATION_SECONDS,
                }));

                if (assumed.Credentials) {
                    creds = {
                        accessKeyId: assumed.Credentials.AccessKeyId!,
                        secretAccessKey: assumed.Credentials.SecretAccessKey!,
                        sessionToken: assumed.Credentials.SessionToken!,
                        region,
                        expiresAt: assumed.Credentials.Expiration!.toISOString(),
                    };
                }
            } catch (stsError) {
                // Non-fatal: connect to shell without AWS credentials
                console.warn('API - STS AssumeRole failed, connecting without AWS credentials:', stsError instanceof Error ? stsError.message : stsError);
            }
        }

        // Build WebSocket URL for the client to connect to
        const credsParam = creds
            ? Buffer.from(JSON.stringify(creds)).toString('base64')
            : undefined;

        const wsParams = new URLSearchParams({ sessionId });
        if (credsParam) wsParams.set('creds', credsParam);
        wsParams.set('cols', '220');
        wsParams.set('rows', '50');

        const wsUrl = `ws://${SHELL_SERVER_HOST}?${wsParams.toString()}`;

        return NextResponse.json({
            success: true,
            data: {
                wsUrl,
                sessionId,
                expiresAt: creds?.expiresAt ?? new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString(),
            },
        });
    } catch (error) {
        console.error('API - Error creating shell connection:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create connection' },
            { status: 500 }
        );
    }
}
