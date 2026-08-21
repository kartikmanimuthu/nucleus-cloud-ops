// Colocated route test, matching app/api/right-sizing/recommendations/[id]/route.test.ts.
//
// This is the endpoint that newly moves production traffic onto interruptible capacity, so
// the gates are what matter: RBAC, the typed confirmation, the live pre-flight, and the
// severity of the audit record.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotGuardErrors } from '@/lib/spot-guard-service';

// vi.hoisted, because vi.mock factories are hoisted above ordinary top-level consts — a
// plain `const enableSpot = vi.fn()` fails with "Cannot access before initialization".
const { enableSpot } = vi.hoisted(() => ({ enableSpot: vi.fn() }));

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(async () => 'tenant-a'),
    getSessionUserEmail: vi.fn(async () => 'test-user@example.com'),
}));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn(async () => null) }));
// The service layer is mocked, so its audit logging is out of scope here — that is covered
// by the service-level test. Keeping SpotGuardErrors real means the route's error mapping is
// exercised against the actual sentinel values rather than copies that could drift.
vi.mock('@/lib/spot-guard-service', async () => {
    const actual = await vi.importActual<typeof import('@/lib/spot-guard-service')>('@/lib/spot-guard-service');
    return { SpotGuardErrors: actual.SpotGuardErrors, SpotGuardService: { enableSpot } };
});

const post = async (body: unknown, id = 'svc-1') => {
    const { POST } = await import('./route');
    return POST(
        new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }) as never,
        { params: Promise.resolve({ id }) },
    );
};

beforeEach(() => vi.clearAllMocks());

describe('POST /api/spot-guard/services/[id]/enable', () => {
    it('403s without the update permission, before touching the service layer', async () => {
        const { authorize } = await import('@/lib/rbac/authorize');
        vi.mocked(authorize).mockResolvedValueOnce(
            new Response(JSON.stringify({ success: false }), { status: 403 }) as never,
        );
        const res = await post({ confirm: true, confirmServiceName: 'api' });
        expect(res.status).toBe(403);
        expect(enableSpot).not.toHaveBeenCalled();
    });

    it('400s when confirm is missing', async () => {
        // z.literal(true), not z.boolean(): an absent flag must never mean "proceed".
        const res = await post({ confirmServiceName: 'api' });
        expect(res.status).toBe(400);
        expect(enableSpot).not.toHaveBeenCalled();
    });

    it('400s when confirm is false', async () => {
        const res = await post({ confirm: false, confirmServiceName: 'api' });
        expect(res.status).toBe(400);
        expect(enableSpot).not.toHaveBeenCalled();
    });

    it('400s when confirmServiceName is missing', async () => {
        const res = await post({ confirm: true });
        expect(res.status).toBe(400);
        expect(enableSpot).not.toHaveBeenCalled();
    });

    it('400s on a malformed body rather than throwing', async () => {
        const { POST } = await import('./route');
        const res = await POST(
            new Request('http://localhost/x', { method: 'POST', body: 'not json' }) as never,
            { params: Promise.resolve({ id: 'svc-1' }) },
        );
        expect(res.status).toBe(400);
    });

    it('400s when the typed service name does not match', async () => {
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.CONFIRMATION_MISMATCH));
        const res = await post({ confirm: true, confirmServiceName: 'wrong-name' });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/does not match/i);
    });

    it('rejects a spotWeight outside the ECS range', async () => {
        expect((await post({ confirm: true, confirmServiceName: 'api', spotWeight: 0 })).status).toBe(400);
        expect((await post({ confirm: true, confirmServiceName: 'api', spotWeight: 1001 })).status).toBe(400);
        expect(enableSpot).not.toHaveBeenCalled();
    });

    it('404s for an unknown or cross-tenant service', async () => {
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.NOT_FOUND));
        const res = await post({ confirm: true, confirmServiceName: 'api' });
        expect(res.status).toBe(404);
    });

    it('409s with the cluster provider list when no Spot provider exists', async () => {
        // Actionable, rather than an opaque AWS error surfaced as a 500.
        enableSpot.mockRejectedValueOnce(
            new Error(`${SpotGuardErrors.NO_SPOT_CAPACITY_PROVIDER}: cluster c1 offers [FARGATE]`),
        );
        const res = await post({ confirm: true, confirmServiceName: 'api' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain('FARGATE');
    });

    it('409s while a deployment is already rolling out', async () => {
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.DEPLOYMENT_IN_PROGRESS));
        expect((await post({ confirm: true, confirmServiceName: 'api' })).status).toBe(409);
    });

    it('409s when the service no longer exists in AWS', async () => {
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.SERVICE_NOT_IN_AWS));
        expect((await post({ confirm: true, confirmServiceName: 'api' })).status).toBe(409);
    });

    it('409s when the AWS account is not connected', async () => {
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.ACCOUNT_NOT_FOUND));
        expect((await post({ confirm: true, confirmServiceName: 'api' })).status).toBe(409);
    });

    it('409s with an explanatory message when the account has Spot automation disabled', async () => {
        // ecs:UpdateService is granted to the cross-account role unconditionally, so nothing at
        // the IAM layer stops this call from succeeding on an account that opted out of
        // automation — this 409 is the only thing that does. Assert the message actually
        // explains why, since a bare "failed" here would be indistinguishable from any other 409.
        enableSpot.mockRejectedValueOnce(new Error(SpotGuardErrors.SPOT_AUTOMATION_DISABLED));
        const res = await post({ confirm: true, confirmServiceName: 'api' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/automation/i);
    });

    it('202s on success and forwards the confirmation input', async () => {
        enableSpot.mockResolvedValueOnce({ id: 'svc-1', serviceName: 'api' });
        const res = await post({ confirm: true, confirmServiceName: 'api', spotWeight: 100, onDemandBase: 1 });
        expect(res.status).toBe(202);
        expect(enableSpot).toHaveBeenCalledWith(
            'tenant-a',
            { kind: 'registry', id: 'svc-1' },
            'test-user@example.com',
            expect.objectContaining({ confirmServiceName: 'api', spotWeight: 100, onDemandBase: 1 }),
        );
    });

    it('parses a composite id from the eligible list as a discovered target', async () => {
        // Lets the first opt-in happen straight from the eligible-services list, with no
        // separate register step.
        enableSpot.mockResolvedValueOnce({ id: 'new', serviceName: 'api' });
        await post({ confirm: true, confirmServiceName: 'api' }, '111111111111:ap-south-1:cluster-a:api');
        expect(enableSpot).toHaveBeenCalledWith(
            'tenant-a',
            {
                kind: 'discovered',
                accountId: '111111111111',
                region: 'ap-south-1',
                clusterName: 'cluster-a',
                serviceName: 'api',
            },
            'test-user@example.com',
            expect.anything(),
        );
    });

    it('treats a non-12-digit first segment as a registry id, not a target', async () => {
        // cuid ids contain no colons, but this guards the discriminator itself.
        enableSpot.mockResolvedValueOnce({ id: 'x', serviceName: 'api' });
        await post({ confirm: true, confirmServiceName: 'api' }, 'not-an-account:a:b:c');
        expect(enableSpot).toHaveBeenCalledWith(
            'tenant-a',
            { kind: 'registry', id: 'not-an-account:a:b:c' },
            'test-user@example.com',
            expect.anything(),
        );
    });
});
