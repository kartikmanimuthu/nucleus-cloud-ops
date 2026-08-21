/**
 * drop-tenant-module.ts — one-shot script to delete a TENANT-LOCAL rbac_modules
 * row and everything that references it. Written to remove `TampModule`, a
 * leftover demo module created through the (now-removed) Modules admin screen,
 * but it takes the key as an argument so it works for any tenant-local module.
 *
 * Unlike the backfill scripts this needs DATABASE_URL loaded explicitly — a bare
 * `tsx` run does not pick up the root .env the way next.config.mjs does:
 *
 *   cd apps/web-ui
 *   tsx --env-file=../../.env scripts/drop-tenant-module.ts                      # dry run, writes nothing
 *   tsx --env-file=../../.env scripts/drop-tenant-module.ts --commit             # apply
 *   tsx --env-file=../../.env scripts/drop-tenant-module.ts --key=Foo --commit   # a different module
 *   tsx --env-file=../../.env scripts/drop-tenant-module.ts --id=<cuid> --commit # pin one exact row
 *
 * NOTE the flag polarity is the OPPOSITE of backfill-modules.ts /
 * backfill-permissions.ts: those apply by default and inspect with --dry-run.
 * This script DELETEs, so it inspects by default and needs an explicit
 * --commit. `--dry-run` is accepted as a no-op alias so muscle memory from the
 * backfill scripts does not accidentally apply anything.
 *
 * Why a script and not registry-admin-writes.deleteModule(): that function
 * deliberately refuses a module that still covers subjects or is granted by
 * rules ("Move them to another module first" / "Untick it in those roles
 * first"). That guard is right for an operator editing live permissions and
 * wrong for unwinding throwaway data, so this script bypasses it — and
 * therefore has to reproduce the three invariants deleteModule() would have
 * maintained by hand:
 *
 *   1. custom_roles.permissions is NOT a cascade target and is still the
 *      write-side source of truth (see lib/rbac/role-rule-sync.ts) and what
 *      roles-list.tsx renders. Leave the key behind and the deleted module
 *      keeps appearing on the role card forever.
 *   2. The ability cache key is versioned, not time-based (lib/rbac/registry.ts),
 *      so Tenant.rbacVersion must be bumped or warm processes keep compiling
 *      the stale ability. Mirrors withRbacVersionBump()'s non-null branch.
 *   3. rbac_rule_change_log gets a `delete` entry appended. The table is
 *      append-only (trigger rbac_ledger_immutable), so prior entries for the
 *      module are left alone by design — the history stays replayable.
 *
 * rbac_subject_modules / rbac_module_actions / rbac_role_rules are removed by
 * FK cascade (onDelete: Cascade in schema.prisma).
 *
 * Known limitations:
 * - Refuses global rows (tenantId IS NULL) and isSystem rows outright. Disable
 *   a system module instead; the compiler contributes nothing for a disabled
 *   module, so its grants stop applying without being destroyed.
 * - Deleting a module that is the ONLY mapping for some subject makes that
 *   subject unreachable by every role. Where a global mapping also exists the
 *   subject falls back to it (this is what happened to `Agent` -> AI Ops when
 *   TampModule went); where it does not, the script warns and needs --force.
 * - Not idempotent in the sense of erasing its own trace: re-running after a
 *   successful delete reports "no module found" and exits 0.
 */

import { PrismaClient, type Prisma } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const COMMIT = process.argv.includes('--commit');
const FORCE = process.argv.includes('--force');
const TARGET_KEY = argValue('key') ?? 'TampModule';
const TARGET_ID = argValue('id');
const ACTOR_ID = argValue('actor-id') ?? 'system';
const ACTOR_EMAIL = argValue('actor-email') ?? 'drop-tenant-module';
const REASON = argValue('reason') ?? `Remove leftover tenant module '${TARGET_KEY}' (manual cleanup)`;

// Remote DBs are slow enough that Prisma's 5s interactive-transaction default
// expires mid-run, which rolls back a half-reported delete.
const TX_OPTS = { maxWait: 20_000, timeout: 120_000 };

async function main(): Promise<void> {
    console.log(`drop-tenant-module — ${COMMIT ? 'APPLYING' : 'DRY RUN (no writes)'}`);

    const targets = await prisma.rbacModule.findMany({
        where: TARGET_ID ? { id: TARGET_ID } : { key: TARGET_KEY },
        orderBy: { createdAt: 'asc' },
    });

    if (targets.length === 0) {
        console.log(`drop-tenant-module — no module found for ${TARGET_ID ? `id '${TARGET_ID}'` : `key '${TARGET_KEY}'`} — nothing to do`);
        return;
    }

    // ── Validate every target before writing anything ───────────────────────
    const refusals: string[] = [];
    for (const mod of targets) {
        if (mod.tenantId === null) {
            refusals.push(
                `'${mod.key}' (${mod.id}) is a GLOBAL row (tenantId IS NULL) — disable it instead of deleting it`
            );
        }
        if (mod.isSystem) {
            refusals.push(`'${mod.key}' (${mod.id}) is a system module and must not be deleted`);
        }
    }
    if (refusals.length > 0) {
        console.error('drop-tenant-module — ABORTED:');
        for (const line of refusals) console.error(`  refused: ${line}`);
        process.exitCode = 1;
        return;
    }

    for (const mod of targets) {
        const tenantId = mod.tenantId as string;
        console.log(`\n  ${mod.key} ("${mod.label}")  id=${mod.id}  tenant=${tenantId}`);

        const [subjectModules, moduleActions, roleRules] = await Promise.all([
            prisma.rbacSubjectModule.findMany({ where: { moduleId: mod.id }, include: { subject: true } }),
            prisma.rbacModuleAction.findMany({ where: { moduleId: mod.id }, include: { action: true } }),
            prisma.rbacRoleRule.findMany({ where: { moduleId: mod.id }, include: { action: true, role: true } }),
        ]);

        console.log(
            `    cascades: ${subjectModules.length} subject link(s), ` +
                `${moduleActions.length} action cell(s), ${roleRules.length} grant(s)`
        );
        for (const rule of roleRules) {
            console.log(`      grant: ${rule.role.name} -> ${rule.action.key}`);
        }

        // ── Orphan check: does every covered subject have somewhere to land? ──
        const orphaned: string[] = [];
        for (const link of subjectModules) {
            const fallback = await prisma.rbacSubjectModule.count({
                where: { subjectId: link.subjectId, moduleId: { not: mod.id } },
            });
            if (fallback === 0) orphaned.push(link.subject.key);
            else console.log(`      subject '${link.subject.key}' falls back to its other mapping`);
        }
        if (orphaned.length > 0) {
            const msg =
                `subject(s) ${orphaned.map((k) => `'${k}'`).join(', ')} have no other module mapping and ` +
                `would become unreachable by every role`;
            if (!FORCE) {
                console.error(`\ndrop-tenant-module — ABORTED: ${msg}. Re-run with --force to accept this.`);
                process.exitCode = 1;
                return;
            }
            console.warn(`      WARNING (--force): ${msg}`);
        }

        // Date fields must be flattened before they can go into a Json column.
        const snapshot = JSON.parse(
            JSON.stringify({ module: mod, subjectModules, moduleActions, roleRules })
        );

        // ── The legacy shadow copy — no cascade reaches this ─────────────────
        const roles = await prisma.customRole.findMany({ where: { tenantId } });
        const dirty = roles.filter((r) => r.permissions !== null && typeof r.permissions === 'object' && mod.key in (r.permissions as Record<string, unknown>));
        for (const role of dirty) {
            console.log(`    custom_roles.permissions: '${mod.key}' key to drop from role '${role.name}' (${role.id})`);
        }
        if (dirty.length === 0) console.log(`    custom_roles.permissions: no role holds a '${mod.key}' key`);

        if (!COMMIT) continue;

        await prisma.$transaction(async (tx) => {
            for (const role of dirty) {
                const next = { ...(role.permissions as Record<string, unknown>) };
                delete next[mod.key];
                await tx.customRole.update({
                    where: { id: role.id },
                    data: { permissions: next as Prisma.InputJsonValue },
                });
            }

            await tx.rbacModule.delete({ where: { id: mod.id } });

            await tx.tenant.update({
                where: { id: tenantId },
                data: { rbacVersion: { increment: 1 } },
            });

            await tx.rbacRuleChangeLog.create({
                data: {
                    tenantId,
                    entityType: 'module',
                    entityId: mod.id,
                    operation: 'delete',
                    before: snapshot,
                    actorId: ACTOR_ID,
                    actorEmail: ACTOR_EMAIL,
                    reason: REASON,
                },
            });
        }, TX_OPTS);

        console.log(`    deleted, ${dirty.length} role JSON patch(es), rbacVersion bumped, ledger appended`);
    }

    console.log(
        `\ndrop-tenant-module — ${targets.length} module(s) ${COMMIT ? 'deleted' : 'would be deleted'}` +
            `${COMMIT ? '' : ' — re-run with --commit to apply'}`
    );
}

main()
    .catch((error: unknown) => {
        console.error('drop-tenant-module — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
