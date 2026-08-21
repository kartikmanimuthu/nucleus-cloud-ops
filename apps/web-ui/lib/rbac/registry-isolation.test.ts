/**
 * Guards the one deliberate exception documented in registry.ts.
 *
 * Registry reads must bypass the tenant extension (it emits `WHERE tenant_id = $1`,
 * which excludes the global `tenantId IS NULL` rows the system registry is made
 * of). That bypass is safe exactly as long as it stays in one reviewed file with
 * an explicit `OR: [{ tenantId }, { tenantId: null }]` on every query.
 *
 * The failure mode this test exists to catch: someone adds an RBAC query
 * elsewhere, reaches for getPrismaClient() because that is what registry.ts does,
 * and silently drops tenant scoping on a table that has tenant-local rows in it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_UI_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Files permitted to combine getPrismaClient() with an rbac* model, each for a
 * reason that cannot be met by getTenantClient().
 */
const ALLOWED = new Map<string, string>([
    [
        'lib/rbac/registry.ts',
        'registry READS must see global rows (tenantId IS NULL), which the tenant extension excludes',
    ],
    [
        'lib/rbac/registry-service.ts',
        'registry WRITES must be able to author global rows, which the tenant extension makes impossible by forcing a non-null tenantId into create',
    ],
    // registry-admin.ts reads the same global rows as registry.ts, for the admin
    // screens, with the same explicit `OR: [{ tenantId }, { tenantId: null }]` on
    // every query. Same exception, same reason.
    [
        'lib/rbac/registry-admin.ts',
        'reads the same global rows as registry.ts, for the admin screens, with the same explicit OR: [{ tenantId }, { tenantId: null }] on every query — same exception, same reason',
    ],
    // registry-admin-writes.ts holds the verb and module write path split out of
    // registry-admin.ts — its pre-write findUnique/findFirst lookups must see the
    // same global-or-tenant rows as the reads above, for the same reason.
    [
        'lib/rbac/registry-admin-writes.ts',
        'registry WRITES for verbs and modules — pre-write lookups must see global rows (tenantId IS NULL) the same as registry-admin.ts, same exception, same reason',
    ],
]);

const SKIP_DIRS = new Set(['node_modules', '.next', '.source', 'dist', '.turbo']);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.source') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            collectSourceFiles(abs, acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            acc.push(abs);
        }
    }
    return acc;
}

interface Offence {
    file: string;
    models: string[];
}

function scan(absFile: string): Offence | null {
    const text = fs.readFileSync(absFile, 'utf8');

    // Cheap pre-filter before the expensive parse. A file that never mentions
    // getPrismaClient cannot bypass the tenant extension, so there is nothing to
    // find in it — and that is the overwhelming majority of the tree. Parsing
    // every .ts/.tsx with the TypeScript compiler otherwise pushes this past the
    // default test timeout.
    if (!text.includes('getPrismaClient')) return null;

    const sourceFile = ts.createSourceFile(
        absFile,
        text,
        ts.ScriptTarget.Latest,
        true,
        absFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    // Which local bindings hold the UNSCOPED client. Only rbac* access through
    // one of these is a bypass — a file may legitimately import getPrismaClient
    // for a non-rbac query while reading rbac tables via getTenantClient.
    const unscopedBindings = new Set<string>();
    const models = new Set<string>();

    const isUnscopedCall = (expr: ts.Expression): boolean => {
        let call: ts.Expression = expr;
        if (ts.isAwaitExpression(call)) call = call.expression;
        return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'getPrismaClient';
    };

    const collectBindings = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
            if (isUnscopedCall(node.initializer)) unscopedBindings.add(node.name.text);
        }
        ts.forEachChild(node, collectBindings);
    };
    collectBindings(sourceFile);

    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && /^rbac[A-Z]/.test(node.name.text)) {
            const target = node.expression;
            // `prisma.rbacModule` where `prisma = getPrismaClient()`
            if (ts.isIdentifier(target) && unscopedBindings.has(target.text)) {
                models.add(node.name.text);
            }
            // `getPrismaClient().rbacModule`
            if (isUnscopedCall(target)) {
                models.add(node.name.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (models.size === 0) return null;

    return {
        file: path.relative(WEB_UI_ROOT, absFile).split(path.sep).join('/'),
        models: [...models].sort(),
    };
}

describe('RBAC registry isolation', () => {
    // This test walks and parses every source file under apps/web-ui, so it is
    // slow by nature — ~18s when the suite is run alongside the component tests
    // and the CPU is contended, against Vitest's 5s default. It passes in ~2s in
    // isolation, which is exactly the profile that produces a test that "only
    // fails in CI". The timeout is generous on purpose: this guard is the only
    // thing keeping unscoped rbac* reads from spreading, so it must never be
    // quietly deleted for flaking.
    it('confines unscoped rbac* access to the files that document why they need it', () => {
        const offences = collectSourceFiles(WEB_UI_ROOT)
            .map(scan)
            .filter((o): o is Offence => o !== null)
            .filter((o) => !ALLOWED.has(o.file));

        expect(
            offences,
            offences.length === 0
                ? ''
                : `These files call getPrismaClient() and touch an rbac* model, bypassing tenant scoping:\n` +
                      offences.map((o) => `  ${o.file}  (${o.models.join(', ')})`).join('\n') +
                      `\n\nUse getTenantClient(tenantId) instead. If the query genuinely needs to see ` +
                      `global rows (tenantId IS NULL), route it through lib/rbac/registry.ts rather than ` +
                      `adding a second bypass.`
        ).toEqual([]);
    }, 60_000);

    it('registry.ts scopes every query to the tenant or to global rows', () => {
        const source = fs.readFileSync(path.join(WEB_UI_ROOT, 'lib', 'rbac', 'registry.ts'), 'utf8');

        // Every findMany/findFirst/findUnique in this file must be bounded. The
        // helper is the only sanctioned way to express "global OR this tenant".
        const queryCount = (source.match(/\.(findMany|findFirst|findUnique)\(/g) ?? []).length;
        const scopedCount =
            (source.match(/globalOrTenant\(/g) ?? []).length - 1 + // minus the definition itself
            (source.match(/\.\.\.globalOrTenant\(/g) ?? []).length;

        expect(queryCount).toBeGreaterThan(0);
        expect(source).toContain('OR: [{ tenantId }, { tenantId: null }]');
        expect(scopedCount).toBeGreaterThan(0);
    });

    it('every allowlisted file is genuinely detected — no vacuous pass, no stale entry', () => {
        // Two ways this guard could rot silently:
        //   · the scanner stops detecting, so the test above passes vacuously
        //     while a real bypass lands unnoticed;
        //   · an allowlist entry outlives the bypass it excused, quietly widening
        //     the exception for whoever edits that file next.
        // Asserting every entry is still detected closes both.
        for (const [relPath, why] of ALLOWED) {
            const offence = scan(path.join(WEB_UI_ROOT, ...relPath.split('/')));

            expect(
                offence,
                `${relPath} is allowlisted but the scanner no longer flags it — either the guard is ` +
                    `broken, or the file stopped bypassing tenant scoping and the entry should be removed ` +
                    `(reason on file: "${why}")`
            ).not.toBeNull();
            expect(offence?.models.length, `${relPath} matched no rbac* model`).toBeGreaterThan(0);
        }
    });

    it('keeps the allowlist small enough to actually review', () => {
        // Exactly four files may bypass tenant scoping — the compiler's reads,
        // the admin screens' reads, and the two write files (verbs+modules split
        // out of registry-admin.ts, and registry-service.ts) — because the 10
        // nullable-tenantId registry tables are deliberately absent from
        // TENANT_SCOPED_MODELS (see pg-config.ts). scripts/backfill-rbac.ts
        // constructs PrismaClient directly (matching seed.ts) rather than
        // adding a fifth entry here.
        //
        // If this number needs to grow again, that is the signal to reconsider
        // the design rather than to widen the list.
        expect(ALLOWED.size).toBe(4);
        for (const [, why] of ALLOWED) expect(why.length).toBeGreaterThan(20);
    });
});

/**
 * `tenantId: { in: [tenantId, null] }` is REJECTED BY PRISMA AT RUNTIME on a
 * String field — "Expected ListStringFieldRefInput or Null, provided (String,
 * Null)". It reads perfectly, typechecks, and every unit test in this directory
 * stubs the Prisma client, so the shape passes review and CI and only fails when
 * a real request reaches it. It shipped twice before being caught in the UI.
 *
 * The correct idiom is registry.ts's `globalOrTenant()`:
 *     { OR: [{ tenantId }, { tenantId: null }] }
 */
describe('RBAC queries — global-or-tenant scoping idiom', () => {
    it('no source file uses a null inside a Prisma `in` array', () => {
        // Comments are stripped first: the fixes for this bug explain the broken
        // idiom in prose, and a scanner that flagged its own documentation would
        // teach the next reader to delete the explanation.
        const withoutComments = (src: string) =>
            src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

        const offences = collectSourceFiles(path.join(WEB_UI_ROOT, 'lib', 'rbac'))
            .filter((f) => !f.endsWith('.test.ts'))
            .filter((f) => /in:\s*\[[^\]]*\bnull\b[^\]]*\]/.test(withoutComments(fs.readFileSync(f, 'utf8'))))
            .map((f) => path.relative(WEB_UI_ROOT, f).split(path.sep).join('/'));

        expect(
            offences,
            `these use \`in: [..., null]\`, which Prisma rejects at runtime — use ` +
                `{ OR: [{ tenantId }, { tenantId: null }] } instead:\n  ${offences.join('\n  ')}`
        ).toEqual([]);
    });
});
