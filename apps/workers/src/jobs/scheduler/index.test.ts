import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();
const mockSchedule = vi.fn();
const mockUnschedule = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue('job-id-123');

const mockExecuteSql = vi.fn().mockResolvedValue(undefined);
const mockBoss = {
  work: mockWork,
  schedule: mockSchedule,
  unschedule: mockUnschedule,
  send: mockSend,
  createQueue: vi.fn().mockResolvedValue(undefined),
  updateQueue: vi.fn().mockResolvedValue(undefined),
  // Queue absent by default → register() takes the createQueue('stately') path.
  getQueue: vi.fn().mockResolvedValue(null),
  getDb: vi.fn().mockReturnValue({ executeSql: mockExecuteSql }),
} as any;

const mockRegisterHandler = vi.fn();
const mockExecute = vi.fn().mockResolvedValue(undefined);
const mockExecutor = {
  registerHandler: mockRegisterHandler,
  execute: mockExecute,
};

vi.mock('./services/scheduler-service.js', () => ({
  runFullScan: vi.fn().mockResolvedValue({ success: true, mode: 'full' }),
  runPartialScan: vi.fn().mockResolvedValue({ success: true, mode: 'partial' }),
}));

vi.mock('./services/pg-service.js', () => ({
  getActiveTenants: vi.fn().mockResolvedValue([{ id: 'tenant-1', name: 'Tenant One' }]),
  getTenantJobConfig: vi.fn().mockResolvedValue({ intervalMinutes: 60, lastRunAt: null }),
  // Atomic claim gate replaces read-compare-write.
  tryClaimTenantRun: vi.fn().mockResolvedValue(true),
  releaseTenantJobClaim: vi.fn().mockResolvedValue(undefined),
}));

import { register } from './index.js';

function fanOutHandler() {
  return mockWork.mock.calls.find((c: any[]) => c[0] === 'scheduler-fan-out')![2];
}
function scanHandler() {
  return mockWork.mock.calls.find((c: any[]) => c[0] === 'scheduler-scan')![2];
}

describe('scheduler job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue('job-id-123');
  });

  it('schedules the fan-out cron as */5 with a cron-only singletonKey', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockSchedule).toHaveBeenCalledWith(
      'scheduler-fan-out',
      '*/5 * * * *',
      {},
      { tz: 'UTC', singletonKey: 'scheduler-cron' }
    );
  });

  it('retires the legacy cron that fired directly on scheduler-scan', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockUnschedule).toHaveBeenCalledWith('scheduler-scan');
  });

  it('creates scheduler-scan with stately policy + retryLimit 0 when absent', async () => {
    mockBoss.getQueue.mockResolvedValueOnce(null);
    await register(mockBoss, mockExecutor);
    expect(mockBoss.createQueue).toHaveBeenCalledWith(
      'scheduler-scan',
      expect.objectContaining({ name: 'scheduler-scan', policy: 'stately', retryLimit: 0 })
    );
    expect(mockExecuteSql).not.toHaveBeenCalled();
  });

  it('migrates a legacy standard queue to stately and PURGES the backlog', async () => {
    mockBoss.getQueue.mockResolvedValueOnce({ name: 'scheduler-scan', policy: 'standard' });
    await register(mockBoss, mockExecutor);
    expect(mockExecuteSql).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM pgboss\.job WHERE name = \$1 AND state NOT IN \('completed'\)/),
      ['scheduler-scan']
    );
    expect(mockExecuteSql).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE pgboss\.queue SET policy = 'stately'.*WHERE name = \$1/),
      ['scheduler-scan']
    );
  });

  it('does NOT purge or re-migrate when the queue is already stately', async () => {
    mockBoss.getQueue.mockResolvedValueOnce({ name: 'scheduler-scan', policy: 'stately' });
    await register(mockBoss, mockExecutor);
    expect(mockExecuteSql).not.toHaveBeenCalled();
  });

  it('registers the scan handler with the executor', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockRegisterHandler).toHaveBeenCalledWith('scheduler-scan', expect.any(Function));
  });

  it('enforces retryLimit 0 + a bounded expiry on scheduler-scan', async () => {
    await register(mockBoss, mockExecutor);
    const call = mockBoss.updateQueue.mock.calls.find((c: any[]) => c[0] === 'scheduler-scan');
    expect(call![1]).toEqual(expect.objectContaining({ name: 'scheduler-scan', retryLimit: 0 }));
    expect(call![1].expireInSeconds).toBeGreaterThan(120);
  });

  it('registers a scheduler-reschedule drain consumer', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockBoss.createQueue).toHaveBeenCalledWith('scheduler-reschedule');
    expect(mockWork.mock.calls.find((c: any[]) => c[0] === 'scheduler-reschedule')).toBeDefined();
  });

  // ---- fan-out handler (the cron tick) --------------------------------------

  it('claims and dispatches a per-tenant scan when the claim is granted', async () => {
    const pg = await import('./services/pg-service.js');
    vi.mocked(pg.tryClaimTenantRun).mockResolvedValue(true);

    await register(mockBoss, mockExecutor);
    await fanOutHandler()();

    expect(pg.tryClaimTenantRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', 60 * 60 * 1000);
    expect(mockSend).toHaveBeenCalledWith(
      'scheduler-scan',
      expect.objectContaining({ triggeredBy: 'system', tenantId: 'tenant-1' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
    );
  });

  it('does not dispatch when the claim is denied (interval not elapsed)', async () => {
    const pg = await import('./services/pg-service.js');
    vi.mocked(pg.tryClaimTenantRun).mockResolvedValue(false);

    await register(mockBoss, mockExecutor);
    await fanOutHandler()();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not throw when a dispatch send fails (loop continues)', async () => {
    const pg = await import('./services/pg-service.js');
    vi.mocked(pg.tryClaimTenantRun).mockResolvedValue(true);
    mockSend.mockRejectedValueOnce(new Error('transient enqueue error'));

    await register(mockBoss, mockExecutor);
    await expect(fanOutHandler()()).resolves.toBeUndefined();
    // A failed dispatch releases the claim so the tenant retries next tick.
    expect(pg.releaseTenantJobClaim).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', 60 * 60 * 1000);
  });

  // ---- scan consumer (runs manual + system jobs) ----------------------------

  it('delegates each scan job to the executor with idempotency + timeout', async () => {
    await register(mockBoss, mockExecutor);
    const manual = { triggeredBy: 'web-ui', tenantId: 'tenant-9' };
    await scanHandler()([{ id: 'job-7', data: manual }]);

    expect(mockExecute).toHaveBeenCalledWith(
      'scheduler-scan',
      manual,
      expect.objectContaining({ idempotencyKey: 'job-7', timeoutMs: expect.any(Number) })
    );
  });

  it('runs an empty ({}) job payload without gating in the scan consumer', async () => {
    await register(mockBoss, mockExecutor);
    await scanHandler()([{ id: 'job-8', data: {} }]);
    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', {}, expect.any(Object));
  });
});
