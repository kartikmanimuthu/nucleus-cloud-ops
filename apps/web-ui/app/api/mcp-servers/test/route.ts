import { handleMcpTest } from '@/lib/agent/mcp-test-handler';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'update', subject: 'McpServer' },
};

export async function POST(req: Request) {
    return handleMcpTest(req);
}
