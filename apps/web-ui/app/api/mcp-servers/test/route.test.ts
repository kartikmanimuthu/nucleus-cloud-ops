import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/mcp-test-handler', () => ({ handleMcpTest: vi.fn() }));

import { handleMcpTest } from '@/lib/agent/mcp-test-handler';
import { POST } from './route';

describe('POST /api/mcp-servers/test', () => {
    beforeEach(() => vi.clearAllMocks());

    it('delegates directly to handleMcpTest and returns its response', async () => {
        const expected = new Response(JSON.stringify({ ok: true }), { status: 200 });
        vi.mocked(handleMcpTest).mockResolvedValue(expected);

        const req = new Request('http://localhost/api/mcp-servers/test', { method: 'POST' });
        const res = await POST(req);

        expect(handleMcpTest).toHaveBeenCalledWith(req);
        expect(res).toBe(expected);
    });
});
