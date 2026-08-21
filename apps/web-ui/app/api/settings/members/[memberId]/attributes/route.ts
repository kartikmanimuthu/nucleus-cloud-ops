/**
 * Principal attributes for one member (Workstream E).
 *
 * These are the SUBJECT side of ABAC: `{"$var": "user.allowedAccountIds"}` in a
 * rule's conditions resolves against the rows this endpoint writes. Without them
 * a condition can only reference identity, and "this contractor may only touch
 * these three AWS accounts" is inexpressible.
 *
 * Writes go through runRbacMutation so the version bump, the ledger append and
 * the audit row cannot be forgotten — a permission-affecting change that does not
 * bump the version is invisible to every running task for as long as its cache
 * entry lives.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { authorize } from '@/lib/rbac/authorize';
import { loadAssignablePrincipalAttributes } from '@/lib/rbac/registry';
import { runRbacMutation } from '@/lib/rbac/registry-service';
import type { RouteAuthz } from '@nucleus/rbac';

export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'User' },
    PUT: { action: 'update', subject: 'User' },
};

/**
 * Only keys the registry declares with source='user' may be assigned. Read via
 * registry.ts, which owns the global-rows query — this route must not open a
 * second bypass of the tenant extension.
 */
const loadAssignableKeys = loadAssignablePrincipalAttributes;

function valueMatchesType(value: unknown, valueType: string): boolean {
    switch (valueType) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'string[]':
            return Array.isArray(value) && value.every((v) => typeof v === 'string');
        case 'date':
            return typeof value === 'string' && !Number.isNaN(Date.parse(value));
        default:
            return false;
    }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
    console.log('API - GET /api/settings/members/[memberId]/attributes - Fetching principal attributes');
    const authError = await authorize('read', 'User');
    if (authError) return authError;

    try {
        const { memberId } = await params;
        const tenantId = await getSessionTenantId();
        const db = getTenantClient(tenantId);

        const member = await db.userTenantRole.findUnique({ where: { id: memberId } });
        if (!member) {
            return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
        }

        const [assignable, assigned] = await Promise.all([
            loadAssignableKeys(tenantId),
            db.rbacUserAttribute.findMany({
                where: { userId: member.userId },
                select: { key: true, value: true, updatedAt: true, updatedBy: true },
            }),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                userId: member.userId,
                email: member.email,
                assignable,
                values: Object.fromEntries(assigned.map((a) => [a.key, a.value])),
            },
        });
    } catch (error) {
        console.error('API - Error fetching principal attributes:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to load attributes' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
    console.log('API - PUT /api/settings/members/[memberId]/attributes - Updating principal attributes');
    const authError = await authorize('update', 'User');
    if (authError) return authError;

    try {
        const { memberId } = await params;
        const body = (await request.json()) as { values?: Record<string, unknown>; reason?: string };
        const values = body.values;

        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            return NextResponse.json({ success: false, error: 'values object is required' }, { status: 400 });
        }

        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const actorId = session?.user?.id ?? 'unknown';
        const actorEmail = session?.user?.email ?? 'unknown';

        const db = getTenantClient(tenantId);
        const member = await db.userTenantRole.findUnique({ where: { id: memberId } });
        if (!member) {
            return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
        }

        // Reject anything the registry does not declare. The $var allowlist is
        // what keeps arbitrary content out of the condition matcher, and it is
        // enforced here as well as at compile time.
        const assignable = await loadAssignableKeys(tenantId);
        const byKey = new Map(assignable.map((a) => [a.key, a]));

        for (const [key, value] of Object.entries(values)) {
            const declared = byKey.get(key);
            if (!declared) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `'${key}' is not an assignable principal attribute`,
                    },
                    { status: 400 }
                );
            }
            if (value !== null && !valueMatchesType(value, declared.valueType)) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `'${key}' expects ${declared.valueType}`,
                    },
                    { status: 400 }
                );
            }
        }

        const before = Object.fromEntries(
            (
                await db.rbacUserAttribute.findMany({
                    where: { userId: member.userId },
                    select: { key: true, value: true },
                })
            ).map((a) => [a.key, a.value])
        );

        await runRbacMutation(
            {
                actor: { userId: actorId, email: actorEmail, tenantId },
                entityType: 'userAttribute',
                entityId: member.userId,
                operation: 'update',
                before,
                after: values,
                reason: body.reason,
            },
            async (tx) => {
                for (const [key, value] of Object.entries(values)) {
                    // null clears the attribute — an absent value is unresolvable
                    // at compile time and DROPS the rule, which is the safe
                    // direction but must be an explicit act, not a typo.
                    if (value === null) {
                        await tx.rbacUserAttribute.deleteMany({
                            where: { tenantId, userId: member.userId, key },
                        });
                        continue;
                    }
                    await tx.rbacUserAttribute.upsert({
                        where: { tenantId_userId_key: { tenantId, userId: member.userId, key } },
                        update: { value: value as never, updatedBy: actorEmail },
                        create: {
                            tenantId,
                            userId: member.userId,
                            key,
                            value: value as never,
                            updatedBy: actorEmail,
                        },
                    });
                }
            }
        );

        return NextResponse.json({ success: true, data: { userId: member.userId, values } });
    } catch (error) {
        console.error('API - Error updating principal attributes:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update attributes' },
            { status: 500 }
        );
    }
}
