/**
 * The complete set of endpoints that Layer 1 does not gate on a permission.
 *
 * Reviewing this file is reviewing that surface — one file instead of 150. Every
 * entry carries a justification, and an entry without one is a review failure,
 * not a style nit.
 *
 * Most of these are also exempted from the NextAuth gate by `config.matcher` in
 * middleware.ts, so they never reach Layer 1 at all — those are reachable with no
 * session whatsoever. The two lists must agree: `rbac:sync --check` fails the
 * build if a route is neither declared nor listed here, but nothing checks the
 * reverse, so a matcher exemption added without a corresponding entry here would
 * silently create an unreviewed public endpoint.
 *
 * An entry that is NOT in `config.matcher`'s exemptions still requires a session
 * — it is merely exempt from needing a *permission*. `/api/me/ability` is the one
 * such case; see its justification.
 *
 * Deliberately NOT public — see the comment above `config.matcher`:
 *   · /api/v1/gateway/api    — ApiAdapter.validateRequest accepts ANY Authorization
 *                              header without validating it
 *   · /api/v1/gateway/stream — session-authenticated UI path
 * Both are session-gated and carry `export const authz` declarations instead.
 */

export interface PublicRoute {
    /** path-to-regexp pattern. `:name*` matches the rest of the path. */
    pattern: string;
    /** Why this endpoint is safe without a permission check. Mandatory. */
    why: string;
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
    {
        pattern: '/api/me/ability',
        why: "Session-gated, NOT in config.matcher's exemptions — a caller with no session gets NextAuth's 401, and the handler itself 401s when getAbilityForSession() returns null. It is exempt from a *permission* because it returns only the caller's own compiled rules, which is what every authenticated user needs before any control can render. Requiring a permission here would be circular: a role that could not read it would boot into an empty ability and see nothing.",
    },
    {
        pattern: '/api/health',
        why: 'ALB and container health probe. Returns liveness only — no tenant data, no side effects.',
    },
    {
        pattern: '/api/auth/:path*',
        why: 'NextAuth internals (callback, session, csrf, providers) plus self-service signup. This IS the authentication system; it cannot require authentication.',
    },
    {
        pattern: '/api/v1/trigger/:path*',
        why: 'Inbound integration triggers. Each adapter verifies its own signature or shared secret in validateRequest before any work happens. EXCEPTION: the `api` channel DOES accept a session cookie (ApiAdapter.validateRequest), so /api/v1/trigger/api carries its own authorize("create", "Agent") for cookie-bearing callers — see the comment there. Any new trigger adapter that accepts a session must do the same.',
    },
    {
        pattern: '/api/v1/gateway/telegram',
        why: 'Telegram webhook — verified via the X-Telegram-Bot-Api-Secret-Token header in the adapter.',
    },
    {
        pattern: '/api/v1/gateway/slack/:path*',
        why: 'Slack events and interactions — verified via Slack HMAC request signing in the adapter. Covers /slack and /slack/interactions.',
    },
    {
        pattern: '/api/v1/gateway/discord',
        why: 'Discord interactions — verified via Ed25519 signature in the adapter.',
    },
    {
        pattern: '/api/v1/gateway/jira',
        why: 'Jira webhook — verified via a shared secret in the adapter.',
    },
    {
        pattern: '/api/v1/gateway/webhook',
        why: 'Generic outbound-integration callback — verified via a per-tenant shared secret in the adapter.',
    },
] as const;
