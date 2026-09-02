import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/gateway', () => ({ getGatewayService: vi.fn() }));

import { getGatewayService } from '@/lib/gateway';
import { POST } from './route';

describe('POST /api/v1/gateway/telegram', () => {
    beforeEach(() => vi.clearAllMocks());

    it('delegates to the gateway service for the "telegram" channel', async () => {
        const expected = new Response('ok');
        const handleInbound = vi.fn().mockResolvedValue(expected);
        vi.mocked(getGatewayService).mockReturnValue({ handleInbound } as any);

        const req = {} as any;
        const res = await POST(req);

        expect(handleInbound).toHaveBeenCalledWith('telegram', req);
        expect(res).toBe(expected);
    });
});
