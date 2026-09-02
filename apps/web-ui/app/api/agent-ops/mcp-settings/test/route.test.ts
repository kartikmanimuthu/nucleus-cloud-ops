import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/mcp-test-handler', () => ({ handleMcpTest: vi.fn() }));

import { handleMcpTest } from '@/lib/agent/mcp-test-handler';
import { POST } from './route';

describe('POST /api/agent-ops/mcp-settings/test', () => {
    beforeEach(() => vi.clearAllMocks());

    it('delegates to the shared MCP test handler', async () => {
        const expected = new Response('ok');
        vi.mocked(handleMcpTest).mockResolvedValue(expected);

        const req = {} as any;
        const res = await POST(req);

        expect(handleMcpTest).toHaveBeenCalledWith(req);
        expect(res).toBe(expected);
    });
});
