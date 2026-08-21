/**
 * reap-orphan-subject-rules.ts — one-shot repair for subject-level grants left
 * behind by a subject remap round trip.
 *
 *   cd apps/web-ui
 *   tsx --env-file=../../.env scripts/reap-orphan-subject-rules.ts                     # dry run, writes nothing
 *   tsx --env-file=../../.env scripts/reap-orphan-subject-rules.ts --commit            # apply
 *   tsx --env-file=../../.env scripts/reap-orphan-subject-rules.ts --subject=Agent     # one subject only
 *
 * Flag polarity matches drop-tenant-module.ts and is the OPPOSITE of the
 * backfill scripts: this DELETEs, so it inspects by default.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * Moving a subject out of its module runs materializeSubjectGrants(), which
 * writes a subject-level rule for every role that held (old module, verb) so the
 * remap does not silently revoke anything. Moving it BACK materializes nothing —
 * the module rules never left the origin, so there is nothing at the source to
 * copy — and the outbound leg's rules survive the round trip permanently.
 *
 * That is what `TampModule` did to `Agent` (see drop-tenant-module.ts's header,
 * which records the same event from the other side). Every role in the tenant
 * came away with subject-level `create/read/update Agent` rules.
 *
 * Those leftovers are not inert:
 *   · rule-compiler.ts step 3 gives a subject-level rule PRECEDENCE over the
 *     module-level rule it duplicates, so the leftover becomes the operative
 *     grant.
 *   · role-rule-sync.ts manages module-level rules ONLY, by design — a
 *     Record<Module, Action[]> cannot express a subject-level rule, so a full
 *     sync would destroy conditional grants nobody meant to touch.
 * Together: unticking AI Ops -> Create deleted the module rule and left the
 * subject-level one granting. A live permission with no checkbox that can
 * revoke it.
 *
 * ── WHAT THIS DELETES ───────────────────────────────────────────────────────
 * A subject-level rule that is unconditional (`conditions IS NULL`), positive
 * (`inverted = false`), AND whose subject is CURRENTLY covered by a module.
 * That last clause is the whole safety argument: while a subject sits inside a
 * module, the roles grid can express any unconditional grant on it, so a
 * subject-level duplicate is either redundant with the grid or contradicting it
 * — and neither is a rule anyone authored on purpose. A subject with no module
 * is left alone: there the subject-level rule is the ONLY thing keeping the
 * grant alive, which is exactly what materializeSubjectGrants() exists to do.
 *
 * Conditional and `cannot` rules are never touched. Each NARROWS or REVERSES
 * the module row rather than repeating it, so deleting either would WIDEN
 * permissions — the opposite of this script's purpose.
 *
 * Each deletion is classified in the output:
 *   REDUNDANT   — the role also holds (module, verb) at module level. Deleting
 *                 changes nothing about what the role can do.
 *   CONTRADICTED — the role does NOT hold it at module level. This is the
 *                 invisible grant; deleting REVOKES a permission that was in
 *                 force. Review these before committing.
 *
 * Invariants maintained by hand, mirroring drop-tenant-module.ts:
 *   1. Tenant.rbacVersion is bumped, or warm processes keep compiling the stale
 *      ability from cache (the key is versioned, not time-based).
 *   2. rbac_rule_change_log gets a `delete` entry per tenant, with the full
 *      before-snapshot, so the change is replayable.
 * custom_roles.permissions is deliberately NOT touched: it never described
 * these rules in the first place, which is the entire bug.
 */

import { PrismaClient, type Prisma } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const COMMIT = process.argv.includes('--commit');
const SUBJECT_KEY = argValue('subject');
const ACTOR_ID = argValue('actor-id') ?? 'system';
const ACTOR_EMAIL = argValue('actor-email') ?? 'reap-orphan-subject-rules';
const REASON =
    argValue('reason') ??
    'Remove subject-level grants orphaned by a subject remap round trip (manual cleanup)';

const TX_OPTS = { maxWait: 20_000, timeout: 120_000 };

interface Candidate {
    id: string;
    tenantId: string | null;
    roleId: string;
    roleName: string;
    actionKey: string;
    subjectKey: string;
    moduleKey: string;
    redundant: boolean;
}

async function main(): Promise<void> {
    console.log(`reap-orphan-subject-rules — ${COMMIT ? 'APPLYING' : 'DRY RUN (no writes)'}`);

    // ── Effective subject -> module link ─────────────────────────────────────
    // A tenant-local link shadows the global one, exactly as mergeBySubjectId()
    // resolves it for the compiler. Getting this backwards would judge a rule
    // against a module the subject no longer belongs to.
    const links = await prisma.rbacSubjectModule.findMany({
        select: { subjectId: true, moduleId: true, tenantId: true },
    });
    const moduleBySubject = new Map<string, string>();
    for (const link of links) {
        const key = `${link.tenantId ?? ''}::${link.subjectId}`;
        moduleBySubject.set(key, link.moduleId);
    }
    const effectiveModule = (subjectId: string, tenantId: string | null): string | undefined =>
        (tenantId ? moduleBySubject.get(`${tenantId}::${subjectId}`) : undefined) ??
        moduleBySubject.get(`::${subjectId}`);

    const [subjects, modules, actions, roles] = await Promise.all([
        prisma.rbacSubject.findMany({ select: { id: true, key: true } }),
        prisma.rbacModule.findMany({ select: { id: true, key: true } }),
        prisma.rbacAction.findMany({ select: { id: true, key: true } }),
        prisma.customRole.findMany({ select: { id: true, name: true } }),
    ]);
    const subjectById = new Map(subjects.map((s) => [s.id, s.key]));
    const moduleById = new Map(modules.map((m) => [m.id, m.key]));
    const actionById = new Map(actions.map((a) => [a.id, a.key]));
    const roleById = new Map(roles.map((r) => [r.id, r.name]));

    // `conditions` is `Json?`, and Prisma reads `{ equals: null }` on a Json
    // column as the JSON VALUE null rather than SQL NULL — it matches nothing.
    // Unconditional-ness is settled in JS below, where it is also visible.
    const rules = await prisma.rbacRoleRule.findMany({
        where: { subjectId: { not: null }, inverted: false },
        select: {
            id: true, tenantId: true, roleId: true, actionId: true, subjectId: true,
            conditions: true, inverted: true, reason: true, createdBy: true, createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
    });

    // Module-level grants, for the REDUNDANT / CONTRADICTED classification.
    const moduleGrants = await prisma.rbacRoleRule.findMany({
        where: { subjectId: null, inverted: false },
        select: { roleId: true, moduleId: true, actionId: true, conditions: true },
    });
    const heldAtModuleLevel = new Set(
        moduleGrants
            .filter((r) => r.moduleId !== null && r.conditions == null)
            .map((r) => `${r.roleId}::${r.moduleId}::${r.actionId}`)
    );

    const candidates: Candidate[] = [];
    let skippedNoModule = 0;

    let skippedConditional = 0;

    for (const rule of rules) {
        // Conditional rules NARROW the module grant rather than repeating it.
        // Deleting one would widen the role to every row — never reap them.
        if (rule.conditions != null) {
            skippedConditional++;
            continue;
        }
        const subjectId = rule.subjectId as string;
        const subjectKey = subjectById.get(subjectId) ?? subjectId;
        if (SUBJECT_KEY && subjectKey !== SUBJECT_KEY) continue;

        const moduleId = effectiveModule(subjectId, rule.tenantId);
        if (!moduleId) {
            // No module covers this subject — the subject-level rule is the only
            // thing granting it. Leave it: this is a genuine preserved grant.
            skippedNoModule++;
            continue;
        }

        candidates.push({
            id: rule.id,
            tenantId: rule.tenantId,
            roleId: rule.roleId,
            roleName: roleById.get(rule.roleId) ?? rule.roleId,
            actionKey: actionById.get(rule.actionId) ?? rule.actionId,
            subjectKey,
            moduleKey: moduleById.get(moduleId) ?? moduleId,
            redundant: heldAtModuleLevel.has(`${rule.roleId}::${moduleId}::${rule.actionId}`),
        });
    }

    if (candidates.length === 0) {
        console.log('reap-orphan-subject-rules — no orphaned subject-level rules found — nothing to do');
        if (skippedNoModule > 0) {
            console.log(`  (${skippedNoModule} rule(s) left alone: their subject has no covering module)`);
        }
        return;
    }

    const contradicted = candidates.filter((c) => !c.redundant);
    console.log(
        `\n  ${candidates.length} rule(s) to delete — ` +
            `${candidates.length - contradicted.length} redundant, ${contradicted.length} contradicted`
    );
    if (skippedNoModule > 0) {
        console.log(`  ${skippedNoModule} rule(s) left alone: their subject has no covering module`);
    }
    if (skippedConditional > 0) {
        console.log(`  ${skippedConditional} rule(s) left alone: conditional grants are never reaped`);
    }
    console.log('');
    for (const c of [...candidates].sort((a, b) => a.roleName.localeCompare(b.roleName))) {
        const tag = c.redundant ? 'REDUNDANT  ' : 'CONTRADICTED';
        console.log(`    ${tag}  ${c.roleName.padEnd(10)} ${c.actionKey} ${c.subjectKey}  (module ${c.moduleKey})`);
    }
    if (contradicted.length > 0) {
        console.log(
            `\n  NOTE: the ${contradicted.length} CONTRADICTED rule(s) are permissions currently IN FORCE ` +
                `that the roles screen does not show. Deleting them revokes access — which is the point, ` +
                `but check the list above matches what those roles are supposed to have.`
        );
    }

    if (!COMMIT) {
        console.log('\nreap-orphan-subject-rules — dry run — re-run with --commit to apply');
        return;
    }

    // Grouped by tenant so each tenant gets its own version bump and ledger
    // entry. A null tenantId means a global preset role's rule; those carry no
    // tenant row to bump, and the GLOBAL version covers them instead.
    const byTenant = new Map<string | null, Candidate[]>();
    for (const c of candidates) {
        const bucket = byTenant.get(c.tenantId);
        if (bucket) bucket.push(c);
        else byTenant.set(c.tenantId, [c]);
    }

    const snapshot = JSON.parse(JSON.stringify(rules.filter((r) => candidates.some((c) => c.id === r.id))));

    await prisma.$transaction(async (tx) => {
        await tx.rbacRoleRule.deleteMany({ where: { id: { in: candidates.map((c) => c.id) } } });

        for (const [tenantId, group] of byTenant) {
            if (tenantId === null) {
                // Preset-role rules live globally; bumping the global version is
                // what invalidates every tenant's cached ability for them.
                await tx.rbacGlobalVersion.update({
                    where: { id: 1 },
                    data: { version: { increment: 1 } },
                });
            } else {
                await tx.tenant.update({
                    where: { id: tenantId },
                    data: { rbacVersion: { increment: 1 } },
                });
            }

            await tx.rbacRuleChangeLog.create({
                data: {
                    tenantId,
                    entityType: 'rule',
                    entityId: group[0].id,
                    operation: 'delete',
                    before: snapshot as Prisma.InputJsonValue,
                    actorId: ACTOR_ID,
                    actorEmail: ACTOR_EMAIL,
                    reason: REASON,
                },
            });
        }
    }, TX_OPTS);

    console.log(
        `\nreap-orphan-subject-rules — deleted ${candidates.length} rule(s) across ` +
            `${byTenant.size} scope(s), versions bumped, ledger appended`
    );
}

main()
    .catch((error: unknown) => {
        console.error('reap-orphan-subject-rules — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
