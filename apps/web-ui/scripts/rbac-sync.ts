/**
 * rbac:sync — the build-time half of Layer 1 (default-deny).
 *
 * AST-scans every `app/api/**\/route.ts`, resolves the permission each exported
 * HTTP handler requires, and emits the committed route manifest that the Node
 * middleware reads at request time (no DB round-trip on the hot path).
 *
 * Resolution per handler, in order:
 *   1. `export const authz` in the route file            → source: 'declared'
 *   2. an `authorize(action, Subject)` call in the body  → source: 'inferred'
 *   3. an entry in `lib/rbac/rbac-allowlist.ts`          → source: 'allowlist'
 *   4. nothing                                           → source: 'undeclared'
 *
 * Step 2 exists so the routes that already call `authorize()` need no hand
 * editing. Step 4 is the whole point: a handler nobody declared is dead on
 * arrival rather than open, and `--check` refuses the build before it ships.
 *
 * Usage:
 *   tsx scripts/rbac-sync.ts            regenerate the manifest
 *   tsx scripts/rbac-sync.ts --check    verify; non-zero exit on drift or gaps
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import type {
    HttpMethod,
    RouteAuthz,
    RouteAuthzEntry,
    RouteManifest,
    RouteManifestEntry,
    RouteManifestMethod,
} from '@nucleus/rbac';

const HTTP_METHODS: readonly HttpMethod[] = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
];

const WEB_UI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_UI_ROOT, '..', '..');
const API_ROOT = path.join(WEB_UI_ROOT, 'app', 'api');
const MANIFEST_PATH = path.join(REPO_ROOT, 'libs', 'rbac', 'generated', 'route-manifest.json');
const ALLOWLIST_PATH = path.join(WEB_UI_ROOT, 'lib', 'rbac', 'rbac-allowlist.ts');

// -----------------------------------------------------------------------------
// File discovery
// -----------------------------------------------------------------------------

function findRouteFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...findRouteFiles(abs));
        } else if (entry.isFile() && entry.name === 'route.ts') {
            out.push(abs);
        }
    }
    return out;
}

/**
 * `app/api/schedules/[scheduleId]/route.ts` → `/api/schedules/:scheduleId`
 * `app/api/auth/[...nextauth]/route.ts`     → `/api/auth/:nextauth*`
 * Route groups `(marketing)` are structural only and are stripped.
 */
function toPattern(absFile: string): string {
    const segments = path
        .relative(API_ROOT, path.dirname(absFile))
        .split(path.sep)
        .filter(Boolean)
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
        .map((s) => {
            if (s.startsWith('[[...') && s.endsWith(']]')) return `:${s.slice(5, -2)}*`;
            if (s.startsWith('[...') && s.endsWith(']')) return `:${s.slice(4, -1)}*`;
            if (s.startsWith('[') && s.endsWith(']')) return `:${s.slice(1, -1)}`;
            return s;
        });
    return segments.length ? `/api/${segments.join('/')}` : '/api';
}

// -----------------------------------------------------------------------------
// AST helpers
// -----------------------------------------------------------------------------

function isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isHttpMethod(name: string): name is HttpMethod {
    return (HTTP_METHODS as readonly string[]).includes(name);
}

/** Unwraps `x as T` / `x satisfies T` so declarations may carry a type assertion. */
function unwrap(expr: ts.Expression): ts.Expression {
    let current = expr;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
        current = current.expression;
    }
    return current;
}

function literalText(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
}

function calleeName(expr: ts.Expression): string | null {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | null {
    if (!prop.name) return null;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
    return null;
}

/** Parses `{ GET: { action: 'read', subject: 'Schedule' }, ... }`. */
function parseAuthzObject(expr: ts.Expression): RouteAuthz {
    const result: RouteAuthz = {};
    const obj = unwrap(expr);
    if (!ts.isObjectLiteralExpression(obj)) return result;

    for (const prop of obj.properties) {
        const method = propertyName(prop);
        if (!method || !isHttpMethod(method)) continue;
        if (!ts.isPropertyAssignment(prop)) continue;

        const entry = unwrap(prop.initializer);
        if (!ts.isObjectLiteralExpression(entry)) continue;

        let action: string | null = null;
        let subject: string | null = null;
        for (const field of entry.properties) {
            if (!ts.isPropertyAssignment(field)) continue;
            const key = propertyName(field);
            if (key === 'action') action = literalText(field.initializer);
            if (key === 'subject') subject = literalText(field.initializer);
        }
        if (action && subject) result[method] = { action, subject };
    }
    return result;
}

interface InferenceResult {
    entry: RouteAuthzEntry | null;
    /** An `authorize()` call whose arguments are not string literals. */
    nonLiteral: boolean;
}

/** Finds the first `authorize('action', 'Subject')` call inside a handler body. */
function inferFromHandler(node: ts.Node): InferenceResult {
    let entry: RouteAuthzEntry | null = null;
    let nonLiteral = false;

    const visit = (n: ts.Node): void => {
        if (entry) return;
        if (ts.isCallExpression(n) && calleeName(n.expression) === 'authorize') {
            const action = literalText(n.arguments[0]);
            const subject = literalText(n.arguments[1]);
            if (action && subject) {
                entry = { action, subject };
                return;
            }
            if (n.arguments.length >= 2) nonLiteral = true;
        }
        ts.forEachChild(n, visit);
    };

    visit(node);
    return { entry, nonLiteral };
}

// -----------------------------------------------------------------------------
// Allowlist
// -----------------------------------------------------------------------------

interface AllowlistEntry {
    pattern: string;
    why: string;
}

/**
 * Parses `export const PUBLIC_ROUTES = [{ pattern, why }, ...]` from
 * `rbac-allowlist.ts`. Parsed rather than imported so this script stays free of
 * the web-ui module graph (`@/` aliases, next/server, env access).
 *
 * The file is a Workstream D deliverable; until it lands, an absent file simply
 * means "nothing is public", which is the fail-closed default.
 */
function readAllowlist(): AllowlistEntry[] {
    if (!fs.existsSync(ALLOWLIST_PATH)) return [];

    const sourceFile = ts.createSourceFile(
        ALLOWLIST_PATH,
        fs.readFileSync(ALLOWLIST_PATH, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );

    const entries: AllowlistEntry[] = [];
    for (const stmt of sourceFile.statements) {
        if (!ts.isVariableStatement(stmt) || !isExported(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || decl.name.text !== 'PUBLIC_ROUTES') continue;
            if (!decl.initializer) continue;
            const array = unwrap(decl.initializer);
            if (!ts.isArrayLiteralExpression(array)) continue;

            for (const element of array.elements) {
                const obj = unwrap(element);
                if (!ts.isObjectLiteralExpression(obj)) continue;
                let pattern: string | null = null;
                let why: string | null = null;
                for (const field of obj.properties) {
                    if (!ts.isPropertyAssignment(field)) continue;
                    const key = propertyName(field);
                    if (key === 'pattern') pattern = literalText(field.initializer);
                    if (key === 'why') why = literalText(field.initializer);
                }
                if (pattern && why) entries.push({ pattern, why });
            }
        }
    }
    return entries;
}

/**
 * Does an allowlist pattern cover a route pattern?
 *
 * Both sides are path-to-regexp shaped. A literal allowlist segment never covers
 * a dynamic route segment — `/api/accounts` must not silently make
 * `/api/accounts/:accountId` public.
 */
function allowlistCovers(allowPattern: string, routePattern: string): boolean {
    const allow = allowPattern.split('/').filter(Boolean);
    const route = routePattern.split('/').filter(Boolean);

    for (let i = 0; i < allow.length; i++) {
        const segment = allow[i];
        if (segment.startsWith(':') && segment.endsWith('*')) return true; // covers the rest
        if (i >= route.length) return false;
        if (segment.startsWith(':')) continue; // matches exactly one segment
        if (segment !== route[i]) return false;
    }
    return allow.length === route.length;
}

// -----------------------------------------------------------------------------
// Scan
// -----------------------------------------------------------------------------

interface Finding {
    file: string;
    method: HttpMethod;
    kind: 'undeclared' | 'non-literal' | 'mismatch';
    detail?: string;
}

function buildManifest(): { manifest: RouteManifest; findings: Finding[] } {
    const allowlist = readAllowlist();
    const routes: RouteManifestEntry[] = [];
    const findings: Finding[] = [];

    for (const absFile of findRouteFiles(API_ROOT).sort()) {
        const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join('/');
        const pattern = toPattern(absFile);

        const sourceFile = ts.createSourceFile(
            absFile,
            fs.readFileSync(absFile, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        const handlers = new Map<HttpMethod, ts.Node>();
        // Every top-level binding, so `export { handler as GET }` can be followed
        // back to the declaration it re-exports (the NextAuth catch-all does this).
        const locals = new Map<string, ts.Node>();
        let declared: RouteAuthz = {};

        for (const stmt of sourceFile.statements) {
            if (ts.isFunctionDeclaration(stmt) && stmt.name) {
                locals.set(stmt.name.text, stmt);
                if (isExported(stmt) && isHttpMethod(stmt.name.text)) handlers.set(stmt.name.text, stmt);
                continue;
            }

            if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                    if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                    locals.set(decl.name.text, decl.initializer);
                    if (!isExported(stmt)) continue;
                    if (isHttpMethod(decl.name.text)) {
                        handlers.set(decl.name.text, decl.initializer);
                    } else if (decl.name.text === 'authz') {
                        declared = parseAuthzObject(decl.initializer);
                    }
                }
                continue;
            }

            // `export { handler as GET, handler as POST }`
            if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const spec of stmt.exportClause.elements) {
                    const exported = spec.name.text;
                    if (!isHttpMethod(exported)) continue;
                    const local = (spec.propertyName ?? spec.name).text;
                    handlers.set(exported, locals.get(local) ?? spec);
                }
            }
        }

        const methods: Partial<Record<HttpMethod, RouteManifestMethod>> = {};

        for (const method of HTTP_METHODS) {
            const handler = handlers.get(method);
            if (!handler) continue;

            const { entry: inferred, nonLiteral } = inferFromHandler(handler);
            const declaredEntry = declared[method];

            if (declaredEntry) {
                // The declaration sits beside the handler and is reviewed in the
                // same diff; if it disagrees with the guard actually in the body,
                // one of the two is a lie. Fail rather than pick a winner.
                if (
                    inferred &&
                    (inferred.action !== declaredEntry.action || inferred.subject !== declaredEntry.subject)
                ) {
                    findings.push({
                        file: relFile,
                        method,
                        kind: 'mismatch',
                        detail: `declared ${declaredEntry.action} ${declaredEntry.subject}, but the handler calls authorize('${inferred.action}', '${inferred.subject}')`,
                    });
                }
                methods[method] = { ...declaredEntry, source: 'declared' };
                continue;
            }

            if (inferred) {
                methods[method] = { ...inferred, source: 'inferred' };
                continue;
            }

            const allowEntry = allowlist.find((a) => allowlistCovers(a.pattern, pattern));
            if (allowEntry) {
                methods[method] = { source: 'allowlist', why: allowEntry.why };
                continue;
            }

            if (nonLiteral) {
                // An authorize() call we cannot read statically gives false
                // confidence; it must be declared explicitly instead.
                findings.push({
                    file: relFile,
                    method,
                    kind: 'non-literal',
                    detail: 'authorize() called with non-literal arguments — add an explicit `authz` declaration',
                });
            } else {
                findings.push({ file: relFile, method, kind: 'undeclared' });
            }
            methods[method] = { source: 'undeclared' };
        }

        if (Object.keys(methods).length > 0) {
            routes.push({ pattern, file: relFile, methods });
        }
    }

    routes.sort((a, b) => (a.pattern === b.pattern ? a.file.localeCompare(b.file) : a.pattern.localeCompare(b.pattern)));

    return { manifest: { version: 1, routes }, findings };
}

function serialise(manifest: RouteManifest): string {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

function main(): void {
    const check = process.argv.includes('--check');
    const { manifest, findings } = buildManifest();
    const serialised = serialise(manifest);

    const handlerCount = manifest.routes.reduce((n, r) => n + Object.keys(r.methods).length, 0);
    const bySource = manifest.routes
        .flatMap((r) => Object.values(r.methods))
        .reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.source]: (acc[m.source] ?? 0) + 1 }), {});

    if (!check) {
        fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
        fs.writeFileSync(MANIFEST_PATH, serialised, 'utf8');
        console.log(`rbac:sync — wrote ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
    }

    console.log(
        `rbac:sync — ${manifest.routes.length} route files, ${handlerCount} HTTP handlers ` +
            `(${Object.entries(bySource)
                .sort()
                .map(([k, v]) => `${v} ${k}`)
                .join(', ')})`
    );

    if (!check) return;

    let failed = false;

    const onDisk = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, 'utf8') : '';
    if (onDisk !== serialised) {
        console.error(
            '\nrbac:sync --check FAILED: the committed manifest is stale.\n' +
                '  Run `bun run rbac:sync` and commit the result.'
        );
        failed = true;
    }

    const blocking = findings.filter((f) => f.kind !== 'undeclared');
    const undeclared = findings.filter((f) => f.kind === 'undeclared');

    if (blocking.length > 0) {
        console.error(`\nrbac:sync --check FAILED: ${blocking.length} declaration problem(s):`);
        for (const f of blocking) console.error(`  ${f.kind.padEnd(12)} ${f.method.padEnd(7)} ${f.file}\n               ${f.detail}`);
        failed = true;
    }

    if (undeclared.length > 0) {
        console.error(
            `\nrbac:sync --check FAILED: ${undeclared.length} HTTP handler(s) declare no permission ` +
                'and match no allowlist entry.\n' +
                '  Layer 1 denies these at runtime. Add `export const authz` to the route file,\n' +
                '  or an entry with a justification to lib/rbac/rbac-allowlist.ts.\n'
        );
        for (const f of undeclared) console.error(`  ${f.method.padEnd(7)} ${f.file}`);
        failed = true;
    }

    if (failed) process.exit(1);
    console.log('rbac:sync --check OK — every handler declares a permission.');
}

main();
