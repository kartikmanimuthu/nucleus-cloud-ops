import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandResource, GRAPH_ENDPOINTS } from '@/lib/queries/resource-graph';

const okJson = (data: unknown) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
} as Response);

describe('graph canvas fetchers', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('calls the expand route with the resource id', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            okJson({ resourceType: 'ec2_instances', resourceId: 'i-1', dependents: { edges: [], total: 0, truncated: false }, dependsOn: { edges: [], total: 0, truncated: false } }));

        await expandResource('i-1');

        expect(spy).toHaveBeenCalledTimes(1);
        const url = String(spy.mock.calls[0][0]);
        expect(url).toContain(GRAPH_ENDPOINTS.expand);
        expect(url).toContain('resourceId=i-1');
    });

    it('url-encodes an ARN resource id rather than corrupting the query string', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            okJson({ resourceType: 'elbv2_load_balancers', resourceId: 'arn:aws:x/y', dependents: { edges: [], total: 0, truncated: false }, dependsOn: { edges: [], total: 0, truncated: false } }));

        await expandResource('arn:aws:x/y');

        const url = String(spy.mock.calls[0][0]);
        expect(url).toContain(encodeURIComponent('arn:aws:x/y'));
    });

    it('throws on an unsuccessful response instead of returning undefined', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ success: false, error: 'boom' }),
        } as Response);

        await expect(expandResource('i-1')).rejects.toThrow();
    });
});
