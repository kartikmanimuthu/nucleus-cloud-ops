import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  shellSession: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock('@/lib/db/pg-config', () => ({
  getTenantClient: vi.fn(() => mockPrisma),
}));

import { ShellSessionService } from '@/lib/shell-session-service';

describe('ShellSessionService', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('creates a session with defaults', async () => {
      const now = new Date();
      mockPrisma.shellSession.count.mockResolvedValue(0);
      mockPrisma.shellSession.create.mockResolvedValue({
        id: 'sess-1',
        tenantId,
        userId,
        accountId: null,
        accountName: null,
        region: 'us-east-1',
        status: 'active',
        approvalMode: 'manual',
        startedAt: now,
        lastActiveAt: now,
        terminatedAt: null,
      });

      const result = await ShellSessionService.createSession(tenantId, userId, {});
      expect(mockPrisma.shellSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId,
          userId,
          status: 'active',
          region: 'us-east-1',
        }),
      });
      expect(result.id).toBe('sess-1');
    });

    it('rejects when max sessions reached', async () => {
      mockPrisma.shellSession.count.mockResolvedValue(3);
      await expect(
        ShellSessionService.createSession(tenantId, userId, {})
      ).rejects.toThrow('Maximum concurrent sessions (3) reached');
    });
  });

  describe('listSessions', () => {
    it('returns active sessions for user', async () => {
      mockPrisma.shellSession.findMany.mockResolvedValue([
        { id: 'sess-1', status: 'active' },
      ]);
      const result = await ShellSessionService.listSessions(tenantId, userId);
      expect(mockPrisma.shellSession.findMany).toHaveBeenCalledWith({
        where: { tenantId, userId, status: 'active' },
        orderBy: { startedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('terminateSession', () => {
    it('sets status to terminated', async () => {
      mockPrisma.shellSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        tenantId,
        userId,
        status: 'active',
      });
      mockPrisma.shellSession.update.mockResolvedValue({
        id: 'sess-1',
        status: 'terminated',
      });

      const result = await ShellSessionService.terminateSession(tenantId, userId, 'sess-1');
      expect(mockPrisma.shellSession.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: expect.objectContaining({ status: 'terminated' }),
      });
      expect(result.status).toBe('terminated');
    });

    it('throws if session not found or not owned', async () => {
      mockPrisma.shellSession.findFirst.mockResolvedValue(null);
      await expect(
        ShellSessionService.terminateSession(tenantId, userId, 'sess-999')
      ).rejects.toThrow('Session not found');
    });
  });
});
