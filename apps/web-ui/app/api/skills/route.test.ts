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
        listByTenant: vi.fn(),
        getBySlug: vi.fn(),
        create: vi.fn(),
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

import { GET, POST } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';

const makeRequest = (body?: unknown, url = 'http://x/api/skills') =>
    ({
        url,
        json: vi.fn().mockResolvedValue(body ?? {}),
    }) as any;

const mockSkill = () => ({
    id: 'abc123',
    slug: 'cost',
    name: 'Cost',
    description: 'd',
    tier: 'read-only' as const,
    source: 'user' as const,
    isEnabled: true,
    createdBy: null,
    content: 'x',
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

describe('GET /api/skills', () => {
    it('returns enabled skills under `skills` key', async () => {
        const repo = { listByTenant: vi.fn().mockResolvedValue([mockSkill()]), getBySlug: vi.fn(), create: vi.fn() };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await GET(makeRequest(undefined));
        const body = (res as any)._data;
        expect(body.success).toBe(true);
        expect(body.skills[0].id).toBe('cost');
        expect(body.skills[0].name).toBe('Cost');
        expect(repo.listByTenant).toHaveBeenCalledWith('t1', { includeDisabled: false });
    });

    it('passes includeDisabled=true when ?all is present', async () => {
        const repo = { listByTenant: vi.fn().mockResolvedValue([]), getBySlug: vi.fn(), create: vi.fn() };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        await GET(makeRequest(undefined, 'http://x/api/skills?all=1'));
        expect(repo.listByTenant).toHaveBeenCalledWith('t1', { includeDisabled: true });
    });

    it('returns 500 on repository error', async () => {
        const repo = { listByTenant: vi.fn().mockRejectedValue(new Error('db error')), getBySlug: vi.fn(), create: vi.fn() };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await GET(makeRequest(undefined));
        expect((res as any)._status).toBe(500);
        expect((res as any)._data.success).toBe(false);
    });

    it('returns 401 with generic body when getSessionTenantId throws Unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no valid session'));
        const res = await GET(makeRequest(undefined));
        expect((res as any)._status).toBe(401);
        expect((res as any)._data).toEqual({ success: false, error: 'Unauthenticated' });
    });
});

describe('POST /api/skills', () => {
    it('403s when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);
        const res = await POST(makeRequest({}));
        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });

    it('400s on missing required fields', async () => {
        vi.mocked(authorize).mockResolvedValue(null);
        const repo = { listByTenant: vi.fn(), getBySlug: vi.fn(), create: vi.fn() };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await POST(makeRequest({ name: 'Only Name' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('409s on duplicate slug', async () => {
        vi.mocked(authorize).mockResolvedValue(null);
        const repo = {
            listByTenant: vi.fn(),
            getBySlug: vi.fn().mockResolvedValue({ id: 'existing', slug: 'cost' }),
            create: vi.fn(),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await POST(makeRequest({ name: 'Cost', description: 'd', tier: 'read-only', content: 'x' }));
        expect((res as any)._status).toBe(409);
        expect((res as any)._data.success).toBe(false);
    });

    it('409s on unique-constraint race (P2002) during create', async () => {
        vi.mocked(authorize).mockResolvedValue(null);
        const p2002 = Object.assign(new Error('Unique constraint violation'), { code: 'P2002' });
        const repo = {
            listByTenant: vi.fn(),
            getBySlug: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockRejectedValue(p2002),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await POST(makeRequest({ name: 'Cost', description: 'd', tier: 'read-only', content: 'x' }));
        expect((res as any)._status).toBe(409);
        expect((res as any)._data.success).toBe(false);
    });

    it('creates skill, returns 201, and audits on success', async () => {
        vi.mocked(authorize).mockResolvedValue(null);
        const created = mockSkill();
        const repo = {
            listByTenant: vi.fn(),
            getBySlug: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(created),
        };
        vi.mocked(getSkillRepository).mockReturnValue(repo as any);
        const res = await POST(makeRequest({ name: 'Cost', description: 'd', tier: 'read-only', content: 'x' }));
        expect((res as any)._status).toBe(201);
        expect((res as any)._data.success).toBe(true);
        expect((res as any)._data.data.id).toBe('cost');
        expect(AuditService.logUserAction).toHaveBeenCalledOnce();
    });
});
