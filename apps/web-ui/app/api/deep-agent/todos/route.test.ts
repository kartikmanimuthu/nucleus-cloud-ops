import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/deep-agent/db/chat-history-store', () => ({
    getThread: vi.fn(), upsertTodos: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));

import { getThread, upsertTodos } from '../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { GET, POST, PATCH, DELETE } from './route';

const makeGetRequest = (search = '') => ({ url: `http://localhost/api/deep-agent/todos${search}` }) as any;
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/deep-agent/todos', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 400 when threadId is missing', async () => {
        const res = await GET(makeGetRequest());
        expect(res.status).toBe(400);
    });

    it('returns an empty list when the thread does not exist', async () => {
        vi.mocked(getThread).mockResolvedValue(null);
        const res = await GET(makeGetRequest('?threadId=t1'));
        const body = await res.json();
        expect(body).toEqual({ todos: [] });
    });

    it('returns the thread todos', async () => {
        vi.mocked(getThread).mockResolvedValue({ todos: [{ id: 'todo-1' }] } as any);
        const res = await GET(makeGetRequest('?threadId=t1'));
        const body = await res.json();
        expect(body.todos).toEqual([{ id: 'todo-1' }]);
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(getThread).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeGetRequest('?threadId=t1'));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/deep-agent/todos', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 400 when threadId or title is missing', async () => {
        const res = await POST(makeRequest({ threadId: 't1' }));
        expect(res.status).toBe(400);
    });

    it('creates a todo appended to existing ones and logs an audit event', async () => {
        vi.mocked(getThread).mockResolvedValue({ todos: [{ id: 'existing' }] } as any);
        vi.mocked(upsertTodos).mockResolvedValue(undefined as any);

        const res = await POST(makeRequest({ threadId: 't1', title: 'New task' }));
        const body = await res.json();

        expect(upsertTodos).toHaveBeenCalledWith('t1', [
            { id: 'existing' },
            expect.objectContaining({ title: 'New task', status: 'pending' }),
        ]);
        expect(res.status).toBe(201);
        expect(body.todo.title).toBe('New task');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.created', tenantId: 'tenant-1' })
        );
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(getThread).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ threadId: 't1', title: 'x' }));
        expect(res.status).toBe(500);
    });
});

describe('PATCH /api/deep-agent/todos', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 400 when threadId or todoId is missing', async () => {
        const res = await PATCH(makeRequest({ threadId: 't1' }));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the thread does not exist', async () => {
        vi.mocked(getThread).mockResolvedValue(null);
        const res = await PATCH(makeRequest({ threadId: 't-missing', todoId: 'todo-1' }));
        expect(res.status).toBe(404);
    });

    it('patches the matching todo and logs an audit event', async () => {
        vi.mocked(getThread).mockResolvedValue({ todos: [{ id: 'todo-1', status: 'pending' }] } as any);
        vi.mocked(upsertTodos).mockResolvedValue(undefined as any);

        const res = await PATCH(makeRequest({ threadId: 't1', todoId: 'todo-1', updates: { status: 'done' } }));
        const body = await res.json();

        expect(upsertTodos).toHaveBeenCalledWith('t1', [expect.objectContaining({ id: 'todo-1', status: 'done' })]);
        expect(res.status).toBe(200);
        expect(body.todos[0].status).toBe('done');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.updated' })
        );
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(getThread).mockRejectedValue(new Error('DB down'));
        const res = await PATCH(makeRequest({ threadId: 't1', todoId: 'todo-1' }));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/deep-agent/todos', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 400 when threadId or todoId is missing', async () => {
        const res = await DELETE(makeRequest({ threadId: 't1' }));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the thread does not exist', async () => {
        vi.mocked(getThread).mockResolvedValue(null);
        const res = await DELETE(makeRequest({ threadId: 't-missing', todoId: 'todo-1' }));
        expect(res.status).toBe(404);
    });

    it('removes the matching todo and logs an audit event', async () => {
        vi.mocked(getThread).mockResolvedValue({ todos: [{ id: 'todo-1' }, { id: 'todo-2' }] } as any);
        vi.mocked(upsertTodos).mockResolvedValue(undefined as any);

        const res = await DELETE(makeRequest({ threadId: 't1', todoId: 'todo-1' }));
        const body = await res.json();

        expect(upsertTodos).toHaveBeenCalledWith('t1', [{ id: 'todo-2' }]);
        expect(res.status).toBe(200);
        expect(body.todos).toEqual([{ id: 'todo-2' }]);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.task.deleted' })
        );
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(getThread).mockRejectedValue(new Error('DB down'));
        const res = await DELETE(makeRequest({ threadId: 't1', todoId: 'todo-1' }));
        expect(res.status).toBe(500);
    });
});
