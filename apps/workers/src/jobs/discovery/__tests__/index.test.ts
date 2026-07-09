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
  // Atomic claim gate (fan-out now uses this instead of read-compare-write).
  tryClaimTenantRun: vi.fn().mockResolvedValue(true),
  releaseTenantJobClaim: vi.fn().mockResolvedValue(undefined),
}));

import { register, resolveScanfilePath } from '../index.js';
import { isAbsolute, join } from 'path';

describe('resolveScanfilePath', () => {
  const baseDir = '/app/dist/jobs/discovery';

  it('defaults to scanfile.json next to the module when unset', () => {
    expect(resolveScanfilePath(undefined, baseDir)).toBe(join(baseDir, 'scanfile.json'));
  });

  it('resolves a relative override against the module dir (cwd-independent)', () => {
    const resolved = resolveScanfilePath('./scanfile.json', baseDir);
    expect(resolved).toBe(join(baseDir, 'scanfile.json'));
    expect(isAbsolute(resolved)).toBe(true);
  });

  it('passes an absolute override through unchanged', () => {
    expect(resolveScanfilePath('/etc/nucleus/scanfile.json', baseDir)).toBe(
      '/etc/nucleus/scanfile.json',
    );
  });
});

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

  it('dispatches a scan per tenant when the claim is granted', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(true);

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(pgService.tryClaimTenantRun).toHaveBeenCalledTimes(2);
  });

  it('claims with the period-derived interval (daily = 24h)', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'daily', lastRunAt: null });
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(true);

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(pgService.tryClaimTenantRun).toHaveBeenCalledWith('tenant-1', 'discovery-cron', 24 * 60 * 60 * 1000);
    expect(pgService.tryClaimTenantRun).toHaveBeenCalledWith('tenant-2', 'discovery-cron', 24 * 60 * 60 * 1000);
  });

  it('does not dispatch when the claim is denied (interval not elapsed)', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(false);

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('claims with the weekly interval when period is weekly', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ period: 'weekly', lastRunAt: null });
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(false);

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(pgService.tryClaimTenantRun).toHaveBeenCalledWith('tenant-1', 'discovery-cron', 7 * 24 * 60 * 60 * 1000);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends with correct singletonKey per tenant', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(true);

    const handler = await getFanOutHandler();
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-1', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
    );
  });

  it('does not throw when send returns null (job already queued/active)', async () => {
    const pgService = await import('../../scheduler/services/pg-service.js');
    vi.mocked(pgService.tryClaimTenantRun).mockResolvedValue(true);
    mockSend.mockResolvedValue(null); // already queued

    const handler = await getFanOutHandler();
    await expect(handler([{ id: 'job-1', data: {} }])).resolves.toBeUndefined();
    // Claim already advanced above; the in-flight scan satisfies the interval, so
    // no compensating release is issued for a duplicate.
    expect(pgService.releaseTenantJobClaim).not.toHaveBeenCalled();
  });
});
