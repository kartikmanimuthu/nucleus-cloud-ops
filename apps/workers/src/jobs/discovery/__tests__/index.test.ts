import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockUpdateQueue = vi.fn().mockResolvedValue(undefined);
const mockGetQueue = vi.fn().mockResolvedValue(null); // null = queue doesn't exist yet
const mockSchedule = vi.fn().mockResolvedValue(undefined);
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue('job-id-123');

const mockBoss = {
  createQueue: mockCreateQueue,
  updateQueue: mockUpdateQueue,
  getQueue: mockGetQueue,
  schedule: mockSchedule,
  work: mockWork,
  send: mockSend,
  getDb: vi.fn().mockReturnValue({ executeSql: vi.fn().mockResolvedValue(undefined) }),
} as any;

const mockRegisterHandler = vi.fn();
const mockExecutor = { registerHandler: mockRegisterHandler, execute: vi.fn() };

vi.mock('../services/account-service.js', () => ({
  getAllTenants: vi.fn().mockResolvedValue([
    { id: 'tenant-1', name: 'Acme' },
    { id: 'tenant-2', name: 'Beta' },
  ]),
  getTenantAccounts: vi.fn().mockResolvedValue([]),
  updateAccountSyncStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../scheduler/services/pg-service.js', () => ({
  getTenantJobConfig: vi.fn().mockResolvedValue({ period: 'daily', lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
}));

import { register } from '../index.js';

describe('discovery register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules daily cron for fan-out', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockSchedule).toHaveBeenCalledWith('discovery-fan-out', '0 0 * * *', {}, { tz: 'UTC' });
  });

  it('registers work handlers for both queues', async () => {
    await register(mockBoss, mockExecutor);
    const names = mockWork.mock.calls.map(c => c[0]);
    expect(names).toContain('discovery-fan-out');
    expect(names).toContain('discovery-scan');
  });

  it('registers handler with executor', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockRegisterHandler).toHaveBeenCalledWith('discovery-scan', expect.any(Function));
  });
});

describe('fan-out handler — per-tenant frequency check', () => {
  beforeEach(() => vi.clearAllMocks());

  async function getFanOutHandler() {
    await register(mockBoss, mockExecutor);
    const call = mockWork.mock.calls.find(c => c[0] === 'discovery-fan-out');
    return call![2];
  }

  it('sends scan jobs for all tenants when lastRunAt is null', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: null });

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledTimes(2);
  });

  it('sends scan job and updates lastRunAt when period has elapsed', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    const oldRun = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago > daily
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: oldRun });

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'discovery-cron', expect.any(String));
    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-2', 'discovery-cron', expect.any(String));
  });

  it('skips tenant when period has not elapsed', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    const recentRun = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago < daily
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: recentRun });

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).not.toHaveBeenCalled();
    expect(pgService.updateTenantJobLastRun).not.toHaveBeenCalled();
  });

  it('respects weekly period threshold', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    const recentRun = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago < weekly
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'weekly', lastRunAt: recentRun });

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends with correct singletonKey per tenant', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: null });

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-1', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
    );
  });

  it('does not update lastRunAt when send returns null (job already queued)', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: null });
    mockSend.mockResolvedValue(null); // already queued

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(pgService.updateTenantJobLastRun).not.toHaveBeenCalled();
  });
});
