import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
}));
vi.mock('@/lib/db/repository-factory', () => ({
    getSkillRepository: vi.fn(() => ({
        getBySlug: vi.fn(),
        getById: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
    })),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/skill-service', () => ({
    slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
}));

import { GET, PATCH, DELETE } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';

const makeParams = (id: string) =>
    ({ params: Promise.resolve({ id }) }) as any;

const makeRequest = (body?: unknown) =>
    ({
        json: vi.fn().mockResolvedValue(body ?? {}),
    }) as any;

const mockSkill = () => ({
    id: 'cuid-abc123',
    slug: 'cost-optimization',
    name: 'Cost Optimization',
    description: 'Optimize AWS costs',
    tier: 'read-only' as const,
    source: 'user' as const,
    isEnabled: true,
    createdBy: null,
    content: 'skill content',
    sourceRunId: null,
    tenantId: 't1',
    createdAt: new Date(),
    updatedAt: new Date(),
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('t1');
    vi.mocked(getAuthSession).mockResolvedValue({
        user: { id: 'u1', email: 'a@b.co', tenantId: 't1' },
    } as any);
    vi.mocked(authorize).mockResolvedValue(null);
    vi.mocked(AuditService.logUserAction).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /api/skills/[id]', () => {
    it('returns 200 with DTO when skill found by slug', async () => {
        const skill = mockSkill();
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(skill),
            getById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await GET(makeRequest(), makeParams('cost-optimization'));

        expect((res as any)._status).toBe(200);
        const body = (res as any)._data;
        expect(body.success).toBe(true);
        // DTO id must be the slug, not the cuid
        expect(body.data.id).toBe('cost-optimization');
        expect(body.data.name).toBe('Cost Optimization');
        expect(repo.getBySlug).toHaveBeenCalledWith('t1', 'cost-optimization');
    });

    it('returns 404 when skill not found by slug', async () => {
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(null),
            getById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await GET(makeRequest(), makeParams('nonexistent-slug'));

        expect((res as any)._status).toBe(404);
        expect((res as any)._data.success).toBe(false);
        expect((res as any)._data.error).toBe('Skill not found');
    });
});

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

describe('PATCH /api/skills/[id]', () => {
    it('returns 200 and calls update with cuid (not slug) on success', async () => {
        const skill = mockSkill();
        const updated = { ...skill, name: 'Cost Opt v2' };
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(skill),
            getById: vi.fn(),
            update: vi.fn().mockResolvedValue(updated),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await PATCH(
            makeRequest({ name: 'Cost Opt v2' }),
            makeParams('cost-optimization')
        );

        expect((res as any)._status).toBe(200);
        expect((res as any)._data.success).toBe(true);
        // Critical: update must be called with the cuid, NOT the slug
        expect(repo.update).toHaveBeenCalledWith('t1', 'cuid-abc123', { name: 'Cost Opt v2' });
        expect(repo.update).not.toHaveBeenCalledWith('t1', 'cost-optimization', expect.anything());
    });

    it('returns 404 when skill not found by slug', async () => {
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(null),
            getById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await PATCH(
            makeRequest({ name: 'New Name' }),
            makeParams('nonexistent-slug')
        );

        expect((res as any)._status).toBe(404);
        expect((res as any)._data.success).toBe(false);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns 403 when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({
            status: 403,
            _data: { error: 'Forbidden' },
            _status: 403,
        } as any);

        const res = await PATCH(
            makeRequest({ name: 'New Name' }),
            makeParams('cost-optimization')
        );

        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });

    it('returns 409 on Prisma P2002 slug collision during update', async () => {
        const skill = mockSkill();
        const p2002 = Object.assign(new Error('Unique constraint violation'), { code: 'P2002' });
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(skill),
            getById: vi.fn(),
            update: vi.fn().mockRejectedValue(p2002),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await PATCH(
            makeRequest({ slug: 'existing-slug' }),
            makeParams('cost-optimization')
        );

        expect((res as any)._status).toBe(409);
        expect((res as any)._data.success).toBe(false);
        expect((res as any)._data.error).toMatch(/already exists/);
    });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/skills/[id]', () => {
    it('returns 200 and calls remove with cuid (not slug) on success', async () => {
        const skill = mockSkill();
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(skill),
            getById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await DELETE(makeRequest(), makeParams('cost-optimization'));

        expect((res as any)._status).toBe(200);
        expect((res as any)._data.success).toBe(true);
        // Critical: remove must be called with the cuid, NOT the slug
        expect(repo.remove).toHaveBeenCalledWith('t1', 'cuid-abc123');
        expect(repo.remove).not.toHaveBeenCalledWith('t1', 'cost-optimization');
    });

    it('returns 404 when skill not found by slug', async () => {
        const repo = {
            getBySlug: vi.fn().mockResolvedValue(null),
            getById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);

        const res = await DELETE(makeRequest(), makeParams('nonexistent-slug'));

        expect((res as any)._status).toBe(404);
        expect((res as any)._data.success).toBe(false);
        expect(repo.remove).not.toHaveBeenCalled();
    });

    it('returns 403 when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({
            status: 403,
            _data: { error: 'Forbidden' },
            _status: 403,
        } as any);

        const res = await DELETE(makeRequest(), makeParams('cost-optimization'));

        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });
});
