import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT } from './route';

const putRequest = (body: unknown) =>
    ({ json: async () => body }) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBAGENTS_ENABLED = 'true';
    vi.mocked(authorize).mockResolvedValue(null as never);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1' as never);
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.com' } } as never);
    vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as never);
});
afterEach(() => { delete process.env.SUBAGENTS_ENABLED; });

describe('GET /api/settings/aiops', () => {
    it('returns the effective budget, bounds, and platform flag', async () => {
        const body = await (await GET()).json();

        expect(body.success).toBe(true);
        expect(body.data.platformEnabled).toBe(true);
        expect(body.data.budget.maxConcurrentSubagents).toBe(3);
        expect(body.data.bounds.maxConcurrentSubagents.max).toBe(6);
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await GET()).toBe(denied);
    });

    it('403s with no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue(null as never);
        expect((await GET()).status).toBe(403);
    });
});

describe('PUT /api/settings/aiops', () => {
    const valid = {
        enabled: true, maxConcurrentSubagents: 4, maxSubagentsPerRun: 8,
        maxSubagentTokensPerRun: 400000, subagentMaxIterations: 8, subagentTimeoutMs: 180000,
    };

    it('saves a valid payload and audits it', async () => {
        const res = await PUT(putRequest(valid));
        const body = await res.json();

        expect(body.success).toBe(true);
        expect(body.data.budget.maxConcurrentSubagents).toBe(4);
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'aiops-subagents', expect.objectContaining({ maxConcurrentSubagents: 4 }), 't1', 'a@b.com',
        );
        expect(AuditService.logUserAction).toHaveBeenCalled();
    });

    it('400s on an out-of-range value', async () => {
        const res = await PUT(putRequest({ ...valid, maxConcurrentSubagents: 999 }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/maxConcurrentSubagents/);
    });

    it('400s when enabled is missing', async () => {
        const { enabled, ...rest } = valid;
        expect((await PUT(putRequest(rest))).status).toBe(400);
    });

    it('persists the clamped value, not the raw one', async () => {
        process.env.SUBAGENT_MAX_CONCURRENCY = '2';
        await PUT(putRequest({ ...valid, maxConcurrentSubagents: 2 }));
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'aiops-subagents', expect.objectContaining({ maxConcurrentSubagents: 2 }), 't1', 'a@b.com',
        );
        delete process.env.SUBAGENT_MAX_CONCURRENCY;
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await PUT(putRequest(valid))).toBe(denied);
    });

    it('403s with no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue(null as never);
        expect((await PUT(putRequest(valid))).status).toBe(403);
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        expect((await PUT(putRequest(valid))).status).toBe(500);
    });
});

describe('PUT /api/settings/aiops (features shape)', () => {
    beforeEach(() => { vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as never); });

    const validFeatures = {
        features: {
            chatTriageEnabled: true, workingMemoryEnabled: true, episodicMemoryEnabled: false,
            proceduralMemoryEnabled: false, memoryReconcileEnabled: false, autoSkillCreationEnabled: false,
            skillSynthesisMinRules: 5, maxIterations: 30,
        },
    };

    it('saves valid feature flags, primes the cache, and audits it', async () => {
        const res = await PUT(putRequest(validFeatures));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'aiops-features', expect.objectContaining({ chatTriageEnabled: true }), 't1', 'a@b.com',
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'aiops.features.settings.updated' })
        );
    });

    it('400s on invalid feature input', async () => {
        const res = await PUT(putRequest({ features: { maxIterations: 'not-a-number' } }));
        expect(res.status).toBe(400);
        expect(TenantConfigService.saveConfig).not.toHaveBeenCalled();
    });
});
