import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { FALLBACK_MAX_ITERATIONS, FALLBACK_DEFAULT_MODE } from '@/lib/agent-ops/agent-ops-defaults';
import { GET, PUT } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/agent-ops/settings/defaults', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('reports unconfigured with the fallback iteration limit when unset', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await GET();
        const body = await res.json();
        expect(body).toEqual({
            configured: false, defaultModel: '', maxIterations: FALLBACK_MAX_ITERATIONS,
            defaultMode: FALLBACK_DEFAULT_MODE,
        });
    });

    it('returns the saved defaults scoped by tenant', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ defaultModel: 'sonnet', maxIterations: 50 } as any);
        const res = await GET();
        const body = await res.json();
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('agent-ops-defaults', 'tenant-1');
        // A config saved before the mode selector existed carries no defaultMode;
        // the route backfills the fallback rather than returning undefined.
        expect(body).toEqual({
            configured: true, defaultModel: 'sonnet', maxIterations: 50,
            defaultMode: FALLBACK_DEFAULT_MODE,
        });
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/agent-ops/settings/defaults', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest({ defaultModel: 'sonnet', maxIterations: 50 }));
        expect(res).toBe(authError);
        expect(TenantConfigService.saveConfig).not.toHaveBeenCalled();
    });

    it('returns 400 when defaultModel is missing', async () => {
        const res = await PUT(makeRequest({ maxIterations: 50 }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when maxIterations is not a valid number', async () => {
        const res = await PUT(makeRequest({ defaultModel: 'sonnet', maxIterations: 'abc' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when maxIterations is a non-integer', async () => {
        const res = await PUT(makeRequest({ defaultModel: 'sonnet', maxIterations: 50.6 }));
        expect(res.status).toBe(400);
        expect(TenantConfigService.saveConfig).not.toHaveBeenCalled();
    });

    it('returns 400 when maxIterations is out of bounds', async () => {
        const res = await PUT(makeRequest({ defaultModel: 'sonnet', maxIterations: 5 }));
        expect(res.status).toBe(400);
    });

    it('saves the trimmed defaults and logs an audit event', async () => {
        const res = await PUT(makeRequest({ defaultModel: '  sonnet  ', maxIterations: 51 }));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-defaults', { defaultModel: 'sonnet', maxIterations: 51 }, 'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body).toEqual({
            success: true, configured: true, defaultModel: 'sonnet', maxIterations: 51,
            defaultMode: FALLBACK_DEFAULT_MODE,
        });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.defaults_updated' })
        );
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await PUT(makeRequest({ defaultModel: 'sonnet', maxIterations: 50 }));
        expect(res.status).toBe(500);
    });
});
