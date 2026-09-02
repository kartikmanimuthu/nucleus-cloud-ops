import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/server before any imports
vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

// Mock next-auth
vi.mock('next-auth', () => ({
    getServerSession: vi.fn(),
}));

// Mock auth options (imported by route files)
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({
    authOptions: {},
}));

// Mock RBAC authorize
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null), // null = authorized
}));

// Gate 3 row filter — same rationale as authorize() above: this route-level
// suite exercises the route's own logic, not RBAC row-filter translation
// (covered by lib/rbac/row-filter.test.ts). null = no narrowing.
vi.mock('@/lib/rbac/row-filter', () => ({
    getReadRowFilter: vi.fn().mockResolvedValue(null),
}));

// Mock AccountService
vi.mock('@/lib/account-service', () => ({
    AccountService: {
        getAccounts: vi.fn(),
        getAccount: vi.fn(),
        createAccount: vi.fn(),
        updateAccount: vi.fn(),
        deleteAccount: vi.fn(),
    },
}));

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authorize } from '@/lib/rbac/authorize';
import { AccountService } from '@/lib/account-service';
import { GET, POST } from '@/app/api/accounts/route';
import {
    GET as getAccountById,
    PUT,
    DELETE,
} from '@/app/api/accounts/[accountId]/route';

// Helper: create a minimal NextRequest-like object
const makeRequest = (url: string, body?: unknown) =>
    ({
        url,
        json: vi.fn().mockResolvedValue(body ?? {}),
    }) as any;

// Helper: create params for dynamic route
const makeParams = (accountId: string) => ({
    params: Promise.resolve({ accountId }),
});

const makeAccount = (overrides: Record<string, unknown> = {}) => ({
    id: 'acc-1',
    accountId: 'acc-1',
    name: 'Test Account',
    roleArn: 'arn:aws:iam::123456789012:role/NucleusRole',
    regions: ['us-east-1'],
    active: true,
    connectionStatus: 'connected',
    description: '',
    resourceCount: 0,
    schedulesCount: 0,
    monthlySavings: 0,
    tags: [],
    lastValidated: '',
    createdBy: 'alice',
    updatedBy: 'alice',
    ...overrides,
});

describe('GET /api/accounts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({
            user: { email: 'alice@example.com', tenantId: 'tenant-test' },
        } as any);
    });

    it('returns 200 with accounts list', async () => {
        vi.mocked(AccountService.getAccounts).mockResolvedValue({
            accounts: [makeAccount()],
            totalCount: 1,
        });

        const req = makeRequest('http://localhost/api/accounts');
        const res = await GET(req);

        expect(res._status).toBe(200);
        expect(res._data).toMatchObject({ success: true, totalCount: 1 });
        expect(res._data.data).toHaveLength(1);
    });

    it('returns 403 when authorize returns an error response', async () => {
        const authError = { _data: { success: false, error: 'Forbidden' }, _status: 403 };
        vi.mocked(authorize).mockResolvedValue(authError as any);

        const req = makeRequest('http://localhost/api/accounts');
        const res = await GET(req);

        // Route returns the authError directly
        expect(res).toBe(authError);
    });

    it('passes statusFilter from query params to AccountService', async () => {
        vi.mocked(AccountService.getAccounts).mockResolvedValue({ accounts: [], totalCount: 0 });

        const req = makeRequest('http://localhost/api/accounts?status=active&search=acme&page=2&limit=5');
        await GET(req);

        expect(AccountService.getAccounts).toHaveBeenCalledWith(
            expect.objectContaining({
                statusFilter: 'active',
                searchTerm: 'acme',
                page: 2,
                limit: 5,
            })
        );
    });

    it('returns 500 when AccountService throws', async () => {
        vi.mocked(AccountService.getAccounts).mockRejectedValue(new Error('DB error'));

        const req = makeRequest('http://localhost/api/accounts');
        const res = await GET(req);

        expect(res._status).toBe(500);
        expect(res._data).toMatchObject({ success: false, error: 'DB error' });
    });
});

describe('POST /api/accounts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({
            user: { email: 'alice@example.com', tenantId: 'tenant-test' },
        } as any);
    });

    it('creates account and returns 200', async () => {
        vi.mocked(AccountService.createAccount).mockResolvedValue(makeAccount() as any);

        const req = makeRequest('http://localhost/api/accounts', {
            accountId: 'acc-new',
            name: 'New Account',
            roleArn: 'arn:aws:iam::111:role/R',
        });
        const res = await POST(req);

        expect(AccountService.createAccount).toHaveBeenCalledOnce();
        expect(res._status).toBe(200);
        expect(res._data).toMatchObject({ success: true });
    });

    it('returns 403 when authorize returns an error response', async () => {
        const authError = { _data: { success: false, error: 'Forbidden' }, _status: 403 };
        vi.mocked(authorize).mockResolvedValue(authError as any);

        const req = makeRequest('http://localhost/api/accounts', {});
        const res = await POST(req);

        expect(res).toBe(authError);
    });

    it('returns 500 when AccountService.createAccount throws', async () => {
        vi.mocked(AccountService.createAccount).mockRejectedValue(new Error('Create failed'));

        const req = makeRequest('http://localhost/api/accounts', { accountId: 'x' });
        const res = await POST(req);

        expect(res._status).toBe(500);
        expect(res._data).toMatchObject({ success: false, error: 'Create failed' });
    });

    it('uses session email as createdBy when not provided in body', async () => {
        vi.mocked(AccountService.createAccount).mockResolvedValue(makeAccount() as any);

        const req = makeRequest('http://localhost/api/accounts', { accountId: 'acc-x', name: 'X' });
        await POST(req);

        const callArg = vi.mocked(AccountService.createAccount).mock.calls[0][0];
        expect(callArg.createdBy).toBe('alice@example.com');
    });
});

describe('GET /api/accounts/[accountId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({
            user: { email: 'alice@example.com', tenantId: 'tenant-test' },
        } as any);
    });

    it('returns 200 with account data when found', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue(makeAccount() as any);

        const req = makeRequest('http://localhost/api/accounts/acc-1');
        const res = await getAccountById(req, makeParams('acc-1'));

        expect(res._status).toBe(200);
        expect(res._data).toMatchObject({ success: true });
        expect(res._data.data.accountId).toBe('acc-1');
    });

    it('returns 404 when account not found', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue(null);

        const req = makeRequest('http://localhost/api/accounts/acc-missing');
        const res = await getAccountById(req, makeParams('acc-missing'));

        expect(res._status).toBe(404);
        expect(res._data).toMatchObject({ success: false, error: 'Account not found' });
    });

    it('returns 500 when AccountService throws', async () => {
        vi.mocked(AccountService.getAccount).mockRejectedValue(new Error('Fetch error'));

        const req = makeRequest('http://localhost/api/accounts/acc-1');
        const res = await getAccountById(req, makeParams('acc-1'));

        expect(res._status).toBe(500);
        expect(res._data).toMatchObject({ success: false });
    });
});

describe('PUT /api/accounts/[accountId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({
            user: { email: 'bob@example.com', tenantId: 'tenant-test' },
        } as any);
        // Pre-flight ownership check (D-03): route loads the existing row before
        // authorizing/mutating, so every test needs a truthy getAccount() by default.
        vi.mocked(AccountService.getAccount).mockResolvedValue(makeAccount() as any);
    });

    it('updates account and returns 200', async () => {
        vi.mocked(AccountService.updateAccount).mockResolvedValue(makeAccount({ name: 'Updated' }) as any);

        const req = makeRequest('http://localhost/api/accounts/acc-1', { name: 'Updated' });
        const res = await PUT(req, makeParams('acc-1'));

        expect(AccountService.updateAccount).toHaveBeenCalledWith(
            'acc-1',
            expect.objectContaining({ name: 'Updated', updatedBy: 'bob@example.com' }),
            'tenant-test'
        );
        expect(res._status).toBe(200);
        expect(res._data).toMatchObject({ success: true });
    });

    it('returns 403 when the account does not exist (pre-flight ownership check)', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue(null);

        const req = makeRequest('http://localhost/api/accounts/acc-missing', { name: 'X' });
        const res = await PUT(req, makeParams('acc-missing'));

        expect(res._status).toBe(403);
        expect(res._data).toMatchObject({ success: false, error: 'Forbidden' });
        expect(AccountService.updateAccount).not.toHaveBeenCalled();
    });

    it('returns 500 when AccountService.updateAccount throws', async () => {
        vi.mocked(AccountService.updateAccount).mockRejectedValue(new Error('Update failed'));

        const req = makeRequest('http://localhost/api/accounts/acc-1', { name: 'X' });
        const res = await PUT(req, makeParams('acc-1'));

        expect(res._status).toBe(500);
        expect(res._data).toMatchObject({ success: false, error: 'Update failed' });
    });

    it('returns the Layer-2 authorize() denial, evaluated against the existing row', async () => {
        vi.mocked(authorize).mockResolvedValueOnce({ _status: 403, _data: { error: 'Forbidden' } } as any);

        const req = makeRequest('http://localhost/api/accounts/acc-1', { name: 'X' });
        const res = await PUT(req, makeParams('acc-1'));

        expect(res).toEqual({ _status: 403, _data: { error: 'Forbidden' } });
        expect(AccountService.updateAccount).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/accounts/[accountId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({
            user: { email: 'carol@example.com', tenantId: 'tenant-test' },
        } as any);
        vi.mocked(AccountService.getAccount).mockResolvedValue(makeAccount() as any);
    });

    it('deletes account and returns 200', async () => {
        vi.mocked(AccountService.deleteAccount).mockResolvedValue(undefined);

        const req = makeRequest('http://localhost/api/accounts/acc-del');
        const res = await DELETE(req, makeParams('acc-del'));

        expect(AccountService.deleteAccount).toHaveBeenCalledWith('acc-del', 'carol@example.com', 'tenant-test');
        expect(res._status).toBe(200);
        expect(res._data).toMatchObject({ success: true });
    });

    it('returns 403 when the account does not exist (pre-flight ownership check)', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue(null);

        const req = makeRequest('http://localhost/api/accounts/acc-missing');
        const res = await DELETE(req, makeParams('acc-missing'));

        expect(res._status).toBe(403);
        expect(res._data).toMatchObject({ success: false, error: 'Forbidden' });
        expect(AccountService.deleteAccount).not.toHaveBeenCalled();
    });

    it('returns 500 when AccountService.deleteAccount throws', async () => {
        vi.mocked(AccountService.deleteAccount).mockRejectedValue(new Error('Delete failed'));

        const req = makeRequest('http://localhost/api/accounts/acc-del');
        const res = await DELETE(req, makeParams('acc-del'));

        expect(res._status).toBe(500);
        expect(res._data).toMatchObject({ success: false, error: 'Delete failed' });
    });

    it('returns the Layer-2 authorize() denial, evaluated against the existing row', async () => {
        vi.mocked(authorize).mockResolvedValueOnce({ _status: 403, _data: { error: 'Forbidden' } } as any);

        const req = makeRequest('http://localhost/api/accounts/acc-del');
        const res = await DELETE(req, makeParams('acc-del'));

        expect(res).toEqual({ _status: 403, _data: { error: 'Forbidden' } });
        expect(AccountService.deleteAccount).not.toHaveBeenCalled();
    });

    it('uses "api-user" as deletedBy when session has no email', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: 'tenant-test' } } as any);
        vi.mocked(AccountService.deleteAccount).mockResolvedValue(undefined);

        const req = makeRequest('http://localhost/api/accounts/acc-del');
        await DELETE(req, makeParams('acc-del'));

        expect(AccountService.deleteAccount).toHaveBeenCalledWith('acc-del', 'api-user', 'tenant-test');
    });
});
