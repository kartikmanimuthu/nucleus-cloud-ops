/**
 * Gate 4 — a scheduled task's stored grant is re-evaluated at EXECUTION time.
 *
 * The property: what the creator could do WHEN THEY CREATED THE TASK is
 * irrelevant. Only what they can do NOW decides whether the task runs. So the
 * fixtures below change the role AFTER creation and assert the outcome flips.
 *
 * The ability comes out of the real compiler over a slice of the system registry
 * seed, because the check turns on the `execute -> update` alias: a version of
 * this code that asked CASL about the raw verb `execute` would find no rule and
 * revoke every task in existence, and only a real compile catches that.
 */

import { createMongoAbility } from '@casl/ability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActionAliasMap, compileRules } from '@nucleus/rbac';
import type { AbilityPrincipal, RbacRoleRuleRow, RegistrySnapshot } from '@nucleus/rbac';

const findUnique = vi.fn();
vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({ authUser: { findUnique } }),
    getTenantClient: () => ({}),
}));

const buildPrincipalFor = vi.fn();
vi.mock('@/lib/rbac/session-ability', () => ({ buildPrincipalFor: (...a: unknown[]) => buildPrincipalFor(...a) }));

const getAbilityForPrincipal = vi.fn();
vi.mock('@/lib/rbac/ability-cache', () => ({
    getAbilityForPrincipal: (...a: unknown[]) => getAbilityForPrincipal(...a),
}));

import { checkScheduledTaskGrant, PERMISSION_REVOKED } from './scheduled-task-permission';
import type { ScheduledTask } from './types';

// ── Registry slice: the AIOps module, the Agent subject, execute -> update ───

const action = (key: string, aliasOfKey: string | null = null) => ({
    id: `a-${key}`, tenantId: null, key, label: key, description: null,
    aliasOfKey, isDangerous: false, sortOrder: 10, isSystem: true,
});

function registry(): RegistrySnapshot {
    return {
        tenantId: 'ten-1',
        modules: [{
            id: 'm-aiops', tenantId: null, key: 'AIOps', label: 'AI Ops', description: null,
            icon: null, navPath: null, sortOrder: 30, isSystem: true, enabled: true,
        }],
        actions: [
            action('create'), action('read'), action('update'), action('delete'),
            action('execute', 'update'),
        ],
        // Both subjects, because SCHEDULED_TASK_REQUIREMENT names ScheduledTask
        // while `Agent` remains the interactive agent's own subject. Keeping both
        // under AIOps means a module grant expands to each, which is what makes
        // the "demoted to read-only" case below fail for the right reason —
        // the verb is missing, not the subject.
        subjects: [
            // navPath/sortOrder are required by RbacSubjectRow since the
            // 20260812100000 migration; the old literal here predated it and was
            // one of the stale fixtures Task 1's review catalogued.
            { id: 's-agent', tenantId: null, key: 'Agent', label: 'Agent', kind: 'resource', navPath: null, sortOrder: 10, isSystem: true },
            { id: 's-schedtask', tenantId: null, key: 'ScheduledTask', label: 'Scheduled Task', kind: 'resource', navPath: '/app/agent-ops/scheduled-tasks', sortOrder: 30, isSystem: true },
        ],
        subjectModules: [
            { tenantId: null, subjectId: 's-agent', moduleId: 'm-aiops' },
            { tenantId: null, subjectId: 's-schedtask', moduleId: 'm-aiops' },
        ],
        moduleActions: ['create', 'read', 'update', 'delete'].map((k) => ({
            tenantId: null, moduleId: 'm-aiops', actionId: `a-${k}`, grantable: true,
        })),
        subjectAttributes: [],
        principalAttributes: [],
    };
}

function principal(roleName: string, roleId: string | null = 'role-1'): AbilityPrincipal {
    return {
        userId: 'u-creator', email: 'creator@example.com', tenantId: 'ten-1',
        roleId, roleName, level: 1, isSuperAdmin: false, attributes: {},
    };
}

/** Wires the mocks so the creator currently holds `actions` on the AIOps module. */
function creatorHolds(roleName: string, actions: string[]) {
    const snapshot = registry();
    const who = principal(roleName);
    const rules: RbacRoleRuleRow[] = actions.map((key) => ({
        id: `r-${key}`, tenantId: null, roleId: who.roleId!, actionId: `a-${key}`,
        moduleId: 'm-aiops', subjectId: null, conditions: null, fields: [], inverted: false, reason: null,
    }));
    const compiled = compileRules(snapshot, rules, who);

    findUnique.mockResolvedValue({ email: who.email, isSuperAdmin: false });
    buildPrincipalFor.mockResolvedValue(who);
    getAbilityForPrincipal.mockResolvedValue({
        ability: createMongoAbility(compiled.rules),
        dropped: [],
        version: '1.0',
        actionAliases: buildActionAliasMap(snapshot.actions),
    });
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
        PK: 'TENANT#ten-1', SK: 'SCHED#task-1', GSI1PK: 'TYPE#SCHEDULED_TASK', GSI1SK: 'ten-1#task-1',
        taskId: 'task-1', tenantId: 'ten-1', name: 'Nightly cleanup', description: 'stop idle instances',
        scheduleType: 'cron', cronExpression: '0 2 * * *', timezone: 'UTC', taskStatus: 'active',
        mode: 'plan', autoApprove: true, notification: { type: 'none' }, runCount: 12,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'creator@example.com',
        createdByUserId: 'u-creator',
        createdByRoleId: 'role-1',
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('checkScheduledTaskGrant', () => {
    it('allows the run while the creator still holds execute on ScheduledTask', async () => {
        creatorHolds('Member', ['create', 'read', 'update']);

        await expect(checkScheduledTaskGrant(task())).resolves.toEqual({
            ok: true, verified: true, userId: 'u-creator', roleName: 'Member',
        });
    });

    it('revokes when the creator was demoted to a read-only role', async () => {
        // The task was created by a Member; the creator is a Viewer NOW.
        creatorHolds('Viewer', ['read']);

        const result = await checkScheduledTaskGrant(task());

        expect(result).toMatchObject({ ok: false, code: PERMISSION_REVOKED });
        expect((result as { reason: string }).reason).toContain("role 'Viewer'");
        expect((result as { reason: string }).reason).toContain('execute ScheduledTask');
    });

    it('revokes when the creator no longer exists', async () => {
        findUnique.mockResolvedValue(null);

        const result = await checkScheduledTaskGrant(task());

        expect(result).toMatchObject({ ok: false, code: PERMISSION_REVOKED });
        expect((result as { reason: string }).reason).toContain('no longer exists');
        expect(buildPrincipalFor).not.toHaveBeenCalled();
    });

    it('revokes when the creator is no longer a member of the tenant', async () => {
        findUnique.mockResolvedValue({ email: 'creator@example.com', isSuperAdmin: false });
        // resolveRole() yields a principal with no roleId once the membership row is gone.
        buildPrincipalFor.mockResolvedValue(principal('', null));

        const result = await checkScheduledTaskGrant(task());

        expect(result).toMatchObject({ ok: false, code: PERMISSION_REVOKED });
        expect((result as { reason: string }).reason).toContain('no longer a member');
        expect(getAbilityForPrincipal).not.toHaveBeenCalled();
    });

    it('resolves the CURRENT role, never the createdByRoleId snapshot', async () => {
        creatorHolds('Viewer', ['read']);

        await checkScheduledTaskGrant(task({ createdByRoleId: 'role-when-they-were-an-owner' }));

        // roleName null => buildPrincipalFor reads user_tenant_roles as it is now.
        expect(buildPrincipalFor).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u-creator', tenantId: 'ten-1', roleName: null }),
        );
    });

    it('fails closed when the permission check itself blows up', async () => {
        findUnique.mockRejectedValue(new Error('registry unreachable'));

        const result = await checkScheduledTaskGrant(task());

        expect(result).toMatchObject({ ok: false, code: PERMISSION_REVOKED });
        expect((result as { reason: string }).reason).toContain('registry unreachable');
    });

    it('lets a legacy row with no recorded creator through, but marks it unverified', async () => {
        const result = await checkScheduledTaskGrant(task({ createdByUserId: undefined }));

        expect(result).toMatchObject({ ok: true, verified: false });
        expect((result as { reason: string }).reason).toContain('createdByUserId is null');
        expect(findUnique).not.toHaveBeenCalled();
    });
});
