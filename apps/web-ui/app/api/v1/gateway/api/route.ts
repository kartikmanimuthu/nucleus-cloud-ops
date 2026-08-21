import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';
import type { RouteAuthz } from '@nucleus/rbac';

/**
 * Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set.
 *
 * `create AgentOps`, not `create Agent`: this is the route the New Agent Run
 * button on /app/agent-ops posts to, so it is governed by the Agent Ops subject
 * the page itself belongs to. Gating it on `Agent` split one screen across two
 * submodules and left the button silently disabled for an admin holding Agent
 * Ops in full. Kept in lockstep with the GatedButton in
 * components/agent-ops/new-run-dialog.tsx — they are one permission stated
 * twice, and `libs/rbac/generated/route-manifest.json` mirrors this declaration
 * (regenerate with `bun run rbac:sync` in apps/web-ui after changing it).
 */
export const authz: RouteAuthz = {
    POST: { action: 'create', subject: 'AgentOps' },
};

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('api', req);
}
