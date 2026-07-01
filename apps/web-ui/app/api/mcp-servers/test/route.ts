import { handleMcpTest } from '@/lib/agent/mcp-test-handler';

export async function POST(req: Request) {
    return handleMcpTest(req);
}
