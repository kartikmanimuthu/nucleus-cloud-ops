import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn().mockResolvedValue('hashed-pw') } }));

import { getPrismaClient } from '@/lib/db/pg-config';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const mockPrisma = { authUser: { findUnique: vi.fn(), create: vi.fn() } };

describe('POST /api/auth/signup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('returns 400 for an invalid email', async () => {
        const res = await POST(makeRequest({ email: 'not-an-email', password: 'password123' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('valid email');
    });

    it('returns 400 for a short password', async () => {
        const res = await POST(makeRequest({ email: 'a@b.co', password: 'short' }));
        expect(res.status).toBe(400);
    });

    it('returns 409 when the email is already registered', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.co' });
        const res = await POST(makeRequest({ email: 'a@b.co', password: 'password123' }));
        expect(res.status).toBe(409);
        expect(mockPrisma.authUser.create).not.toHaveBeenCalled();
    });

    it('creates the user, hashes the password, and logs a signup audit event', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue(null);
        mockPrisma.authUser.create.mockResolvedValue({ id: 'u1' });

        const res = await POST(makeRequest({ email: 'a@b.co', password: 'password123' }));
        const body = await res.json();

        expect(mockPrisma.authUser.create).toHaveBeenCalledWith({
            data: { email: 'a@b.co', passwordHash: 'hashed-pw', isSuperAdmin: false },
        });
        expect(res.status).toBe(201);
        expect(body).toEqual({ success: true, userId: 'u1' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'auth.signup.created', status: 'success' })
        );
    });

    it('returns 500 when the database throws', async () => {
        mockPrisma.authUser.findUnique.mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ email: 'a@b.co', password: 'password123' }));
        expect(res.status).toBe(500);
    });
});
