import { withAuth, NextRequestWithAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

import { resolveNavOwner } from "@nucleus/rbac";

import { getAbilityForPrincipal, getCachedRegistrySnapshot, getRbacVersion } from "@/lib/rbac/ability-cache";
import { canReadOwner, isExemptPath, pageGuardMode, UNAUTHORIZED_PATH } from "@/lib/rbac/page-authz";
import { loadRouteOverrides, resolveRouteRequirement } from "@/lib/rbac/route-authz";
import { buildPrincipalFor } from "@/lib/rbac/session-ability";

/**
 * Layer 1 mode (rollout §16.1):
 *   off     — skip entirely
 *   shadow  — evaluate and LOG what would have been denied, but allow it. Because
 *             116 handlers had no authorization before this, the shadow log is the
 *             discovery mechanism for legitimate access nobody documented.
 *   enforce — deny. This is where the coverage gap actually closes.
 * Default is `shadow`: turning Layer 1 on must never be the thing that breaks prod.
 */
function routeGuardMode(): "off" | "shadow" | "enforce" {
    const raw = process.env.RBAC_ROUTE_GUARD_MODE;
    return raw === "enforce" || raw === "off" ? raw : "shadow";
}

function forbidden(reason: string, action?: string, subject?: string) {
    return NextResponse.json(
        { success: false, error: "Forbidden", message: reason, action, subject },
        { status: 403 }
    );
}

/**
 * The default-deny choke point. Returns a 403 response to short-circuit the
 * request, or null to continue.
 *
 * Everything here fails CLOSED: an unmapped route, an unresolvable principal or a
 * thrown compiler all deny (in enforce mode). The one exception is `off`.
 */
async function enforceLayer1(req: NextRequestWithAuth): Promise<NextResponse | null> {
    const mode = routeGuardMode();
    if (mode === "off") return null;

    const { pathname } = req.nextUrl;
    if (!pathname.startsWith("/api/")) return null;

    const token = req.nextauth.token;
    const method = req.method;

    try {
        const tenantId = (token?.tenantId as string | undefined) ?? "";

        // Public and override resolution does not need a principal.
        const overrides = tenantId
            ? await loadRouteOverrides(tenantId, await getRbacVersion(tenantId))
            : [];
        const requirement = resolveRouteRequirement(method, pathname, overrides);

        if (requirement.mode === "public") return null;

        if (requirement.mode === "deny") {
            console.error(
                "[rbac] rbac.route.denied",
                JSON.stringify({ method, pathname, reason: requirement.reason })
            );
            return mode === "enforce" ? forbidden(requirement.reason) : null;
        }

        if (requirement.mode === "unmapped") {
            // The whole point: an endpoint nobody declared is dead, not open.
            // rbac:sync --check should have refused this build, so reaching here
            // means a route shipped without a declaration.
            console.error("[rbac] rbac.route.unmapped", JSON.stringify({ method, pathname }));
            return mode === "enforce"
                ? forbidden("This endpoint declares no permission requirement.")
                : null;
        }

        if (!token?.sub || !tenantId) {
            console.error(
                "[rbac] rbac.route.no_principal",
                JSON.stringify({ method, pathname, hasToken: Boolean(token) })
            );
            return mode === "enforce" ? forbidden("No resolvable principal.") : null;
        }

        if (token.isSuperAdmin === true) return null;

        const principal = await buildPrincipalFor({
            userId: token.sub,
            email: (token.email as string | undefined) ?? "",
            tenantId,
            roleName: (token.role as string | undefined) ?? null,
            isSuperAdmin: false,
        });
        if (!principal) {
            return mode === "enforce" ? forbidden("No resolvable principal.") : null;
        }

        const { ability, actionAliases } = await getAbilityForPrincipal(principal);
        const action = actionAliases[requirement.action] ?? requirement.action;

        if (ability.can(action, requirement.subject)) return null;

        console.error(
            "[rbac] rbac.route.forbidden",
            JSON.stringify({
                method,
                pathname,
                action: requirement.action,
                subject: requirement.subject,
                role: principal.roleName,
                source: requirement.source,
                enforced: mode === "enforce",
            })
        );
        return mode === "enforce"
            ? forbidden(
                  `You do not have permission to ${requirement.action} ${requirement.subject}`,
                  requirement.action,
                  requirement.subject
              )
            : null;
    } catch (error) {
        // A Layer 1 failure must not silently open the door. In shadow it is
        // logged and allowed so a bug here cannot take production down before the
        // flip; in enforce it denies.
        console.error("[rbac] Layer 1 evaluation failed", { method, pathname }, error);
        return mode === "enforce" ? forbidden("Authorization could not be evaluated.") : null;
    }
}

/**
 * Page admission. Hiding a nav entry is UX only — without this, the URL still
 * works and a bookmark still resolves.
 *
 * Returns a redirect to short-circuit, or null to continue. See page-authz.ts
 * for why an infrastructure failure here allows rather than denies — the
 * OPPOSITE of enforceLayer1's fail-closed contract above. Layer 1 guards data
 * with no other gate; this guards chrome over pages whose API calls are
 * already gated by Layer 1 and by authorize(). An outage here should degrade
 * to an empty-looking page, not lock every user out of the whole app. Do not
 * "fix" this to match enforceLayer1.
 */
export async function enforcePageRead(req: NextRequestWithAuth): Promise<NextResponse | null> {
    const mode = pageGuardMode();
    if (mode === "off") return null;

    const { pathname } = req.nextUrl;
    if (!pathname.startsWith("/app/") && pathname !== "/app") return null;
    if (isExemptPath(pathname)) return null;

    const token = req.nextauth.token;

    try {
        const tenantId = (token?.tenantId as string | undefined) ?? "";
        if (!token?.sub || !tenantId) return null; // NextAuth already gates authentication

        const principal = await buildPrincipalFor({
            userId: token.sub,
            email: (token.email as string | undefined) ?? "",
            tenantId,
            roleName: (token.role as string | undefined) ?? null,
            isSuperAdmin: token.isSuperAdmin === true,
        });
        if (!principal) return null;

        // Cached by RBAC version (ability-cache.ts) — /app/* navigations,
        // including the RSC/prefetch requests the middleware matcher also
        // covers, previously ran loadRegistrySnapshot's 7 findMany's on every
        // request with no cache at all.
        const registry = await getCachedRegistrySnapshot(principal.tenantId);
        const moduleKeyById = new Map(registry.modules.map((m) => [m.id, m.key]));
        const subjects = registry.subjects.map((s) => ({
            id: s.id,
            key: s.key,
            navPath: s.navPath,
            moduleKey:
                moduleKeyById.get(
                    registry.subjectModules.find((link) => link.subjectId === s.id)?.moduleId ?? ""
                ) ?? null,
        }));

        // Matches the client-facing filter in app/api/me/ability/route.ts:
        // the sidebar (client) only shows enabled modules, so the page guard
        // must reason about the same set — otherwise disabling a module via
        // PATCH /api/settings/rbac/modules/[moduleId] can leave the sidebar
        // and the page guard disagreeing about whether its pages are reachable.
        const enabledModules = registry.modules.filter((m) => m.enabled);
        const owner = resolveNavOwner(pathname, subjects, enabledModules);
        // No row claims this path. Allow — same fail-open the sidebar uses, so
        // the two never disagree about an unmapped route.
        if (!owner) return null;

        // Single-arg: getAbilityForPrincipal resolves its own RBAC version
        // internally (ability-cache.ts), unlike Layer 1's loadRouteOverrides
        // above which needs the version explicitly for its own cache key.
        const { ability } = await getAbilityForPrincipal(principal);
        if (canReadOwner(ability, owner, { subjects })) return null;

        if (mode === "shadow") {
            console.warn(
                "[rbac] rbac.page_guard.shadow_denial",
                JSON.stringify({
                    pathname,
                    owner: `${owner.kind}:${owner.key}`,
                    role: principal.roleName,
                    tenantId: principal.tenantId,
                })
            );
            return null;
        }

        return NextResponse.redirect(new URL(UNAUTHORIZED_PATH, req.url));
    } catch (error) {
        // Fail OPEN. See the contract note in page-authz.ts — this is the
        // deliberate divergence from enforceLayer1's catch block above.
        console.error("[rbac] page guard failed, allowing:", error);
        return null;
    }
}

export default withAuth(
    async function middleware(req: NextRequestWithAuth) {
        const token = req.nextauth.token;
        const { pathname } = req.nextUrl;

        // Guard /admin routes — super admin only (per AUTH-06, D-09)
        if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
            if (token?.isSuperAdmin !== true) {
                return NextResponse.json(
                    { error: "Forbidden", message: "Super admin access required" },
                    { status: 403 }
                );
            }
        }

        // No-tenant redirect — authenticated users without tenantId must create org (per D-05)
        // Skip for: /create-org itself, /api routes, /login, /signup, public routes
        const skipNoTenantRedirect =
            pathname === "/create-org" ||
            pathname.startsWith("/api/") ||
            pathname === "/login" ||
            pathname === "/signup" ||
            pathname === "/" ||
            pathname.startsWith("/docs");

        if (!skipNoTenantRedirect && token && !token.tenantId) {
            const createOrgUrl = new URL("/create-org", req.url);
            return NextResponse.redirect(createOrgUrl);
        }

        // Layer 1 — default-deny. Runs AFTER the /admin gate and the tenantless
        // redirect so their behaviour is unchanged, and before x-tenant-id
        // injection so a refused request never reaches a handler.
        const layer1 = await enforceLayer1(req);
        if (layer1) return layer1;

        // Page admission — runs after Layer 1 so /api/ requests never reach it
        // (enforceLayer1 only acts on /api/, enforcePageRead only acts on /app),
        // and after the /admin + tenantless-redirect gates above so their
        // behaviour is unchanged.
        const pageGuard = await enforcePageRead(req);
        if (pageGuard) return pageGuard;

        // Inject x-tenant-id header for downstream API routes (per AUTH-07)
        const requestHeaders = new Headers(req.headers);
        if (token?.tenantId) {
            requestHeaders.set("x-tenant-id", token.tenantId as string);
        }

        return NextResponse.next({
            request: { headers: requestHeaders },
        });
    },
    {
        callbacks: {
            authorized: ({ token, req }) => {
                const { pathname } = req.nextUrl;
                // Internal worker -> web-ui call: the agent-ops scheduler triggers a
                // scheduled task with a shared x-internal-key instead of a NextAuth
                // session. Let it past the auth gate; the route's resolveTenantId still
                // strictly validates the secret (and falls back to session auth if it
                // does not match). Mirrors the api/v1/trigger matcher exemption.
                if (
                    pathname.startsWith("/api/agent-ops/scheduled-tasks/") &&
                    pathname.endsWith("/trigger") &&
                    req.headers.get("x-internal-key")
                ) {
                    return true;
                }
                // Same pattern for the Spot Guard alert relay: the workers process cannot
                // import @/lib/... to reach the per-tenant Slack credentials, so it POSTs
                // here instead. Exact path match (tighter than the startsWith/endsWith pair
                // above). This bypass is NOT the authenticator — the route's own
                // resolveTenantId still requires INTERNAL_API_KEY to be configured AND to
                // match, and falls back to session auth otherwise.
                //
                // config.matcher is deliberately left alone: /api/internal/* already passes
                // through middleware, which is what we want so the /admin guard chain and
                // x-tenant-id injection keep running for every other path.
                if (
                    pathname === "/api/internal/spot-guard/notify" &&
                    req.headers.get("x-internal-key")
                ) {
                    return true;
                }
                // Public routes — no auth required
                if (
                    pathname === "/login" ||
                    pathname === "/signup" ||
                    pathname === "/" ||
                    pathname.startsWith("/docs")
                ) {
                    return true;
                }
                return !!token;
            },
        },
    }
);

// Only the externally-signed webhook channels are exempted from the NextAuth gate —
// each verifies its own signature/secret in the adapter's validateRequest (Telegram's
// X-Telegram-Bot-Api-Secret-Token, Slack's HMAC signature, Discord's Ed25519, Jira's
// shared secret), and none of them can carry a session cookie.
//
// Deliberately NOT exempted: api/v1/gateway/api and api/v1/gateway/stream. Those are
// session-authenticated UI paths — ApiAdapter.validateRequest accepts ANY Authorization
// or x-api-key header without validating it, and this middleware is what overwrites a
// client-supplied x-tenant-id with the session's real tenantId. Exempting them would
// let an unauthenticated caller start an agent run under an arbitrary tenant.
//
// The paths exempted below must stay in sync with lib/rbac/rbac-allowlist.ts —
// they never reach Layer 1 at all, so the allowlist is where their justification
// lives and where they get reviewed.
//
// `api/chat$` used to be exempted here for the Next body-locking bug described
// below. It is back under Layer 1: the bug is fixed at the source by
// patches/next@15.5.15.patch, so chat no longer has to buy uptime with a hole in
// the choke point. route.ts keeps its own authorize('create', 'Agent') call as
// defence in depth.
export const config = {
    // Node.js middleware runtime — stable as of Next 15.5 (this repo is on
    // 15.5.15). Layer 1 needs Prisma to read route overrides and compile the
    // caller's ability, neither of which is possible on the edge runtime.
    //
    // REQUIRES patches/next@15.5.15.patch. Running middleware on the Node.js
    // runtime makes Next clone the request body for it and then swap the drained
    // original for the buffered copy — via an UNAWAITED `finalize()` in
    // next-server.js runMiddleware. Next's own edge path awaits the same call;
    // only this one forgot. Lose that race and the route handler builds its
    // Request from the already-disturbed stream, so Next throws "Response body
    // object should not be disturbed or locked" before the handler runs. It is a
    // race, not a size cutoff, but a body arriving over several TCP chunks loses
    // it reliably — which is why /api/chat 500'd once a thread grew while short
    // chats kept working. It is not chat-specific: every large POST through this
    // matcher is exposed (ask-ai, the gateways, KB uploads).
    //
    // scripts/assert-next-patch.mjs fails the build if the patch is missing, so a
    // Next upgrade cannot silently reopen this. On upgrade, re-check
    // `requestData.body.finalize()` in node_modules/next/dist/server/next-server.js:
    // if upstream now awaits it, delete the patch, the assert script and its
    // prebuild hook; if not, regenerate the patch for the new version.
    runtime: "nodejs",
    matcher: [
        "/((?!api/auth|api/health|api/v1/trigger|api/v1/gateway/telegram|api/v1/gateway/slack|api/v1/gateway/discord|api/v1/gateway/jira|api/v1/gateway/webhook|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login|signup).*)",
    ],
};
