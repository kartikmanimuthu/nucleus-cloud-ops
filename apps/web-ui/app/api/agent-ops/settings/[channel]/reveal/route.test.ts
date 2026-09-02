import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/channels/secret-reveal', () => ({ revealChannelSecrets: vi.fn() }));

import { revealChannelSecrets } from '@/lib/channels/secret-reveal';
import { GET } from './route';

const makeParams = (channel: string) => ({ params: Promise.resolve({ channel }) });

describe('GET /api/agent-ops/settings/[channel]/reveal', () => {
    beforeEach(() => vi.clearAllMocks());

    it('delegates to the shared secret-reveal handler with the channel slug', async () => {
        const expected = new Response('ok');
        vi.mocked(revealChannelSecrets).mockResolvedValue(expected as any);

        const res = await GET({} as any, makeParams('slack'));

        expect(revealChannelSecrets).toHaveBeenCalledWith('slack');
        expect(res).toBe(expected);
    });
});
