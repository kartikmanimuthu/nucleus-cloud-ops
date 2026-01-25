import { NextResponse } from 'next/server';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantUsers } from '@/lib/rbac/role-service';

// Initialize Cognito client
const cognito = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION || process.env.COGNITO_REGION
});

const DEFAULT_TENANT_ID = 'default';

export async function GET(request: Request) {
    // Check authorization - must be able to read users
    const authError = await authorize('read', 'User');
    if (authError) return authError;

    try {
        // Get current session for tenant context
        const session = await getServerSession(authOptions);
        const tenantId = (session?.user as any)?.activeTenantId || DEFAULT_TENANT_ID;

        // Fetch users from Cognito
        const command = new ListUsersCommand({
            UserPoolId: process.env.COGNITO_USER_POOL_ID,
            Limit: 60,
        });

        const cognitoResponse = await cognito.send(command);

        // Fetch role assignments from DynamoDB
        const tenantRoles = await getTenantUsers(tenantId);
        const roleMap = new Map(tenantRoles.map(r => [r.userId, r.role]));

        // Map Cognito users with their roles
        const users = cognitoResponse.Users?.map(user => {
            const sub = user.Attributes?.find(a => a.Name === 'sub')?.Value || '';
            const email = user.Attributes?.find(a => a.Name === 'email')?.Value || '';
            const name = user.Attributes?.find(a => a.Name === 'name')?.Value ||
                user.Attributes?.find(a => a.Name === 'given_name')?.Value || '';

            return {
                id: user.Username,
                sub,
                email,
                name,
                status: user.UserStatus,
                enabled: user.Enabled,
                createdAt: user.UserCreateDate?.toISOString(),
                lastModified: user.UserLastModifiedDate?.toISOString(),
                role: roleMap.get(sub) || null,
                tenantId,
            };
        }) || [];

        return NextResponse.json({
            users,
            tenantId,
            total: users.length,
        });

    } catch (error) {
        console.error('Error fetching users:', error);
        return NextResponse.json(
            { error: 'Failed to fetch users', details: (error as Error).message },
            { status: 500 }
        );
    }
}
