import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();
const mockSchedule = vi.fn();

const mockBoss = {
  work: mockWork,
  schedule: mockSchedule,
  send: vi.fn(),
  createQueue: vi.fn().mockResolvedValue(undefined),
  updateQueue: vi.fn().mockResolvedValue(undefined),
} as any;

const mockRegisterHandler = vi.fn();
// Cron path scopes each scan to a tenant and advances lastRunAt whenever the
// scan actually evaluated that tenant (checkedTenantIds includes it) — even if
// the tenant had no schedules/accounts, so it isn't re-dispatched every tick.
const mockExecute = vi.fn().mockResolvedValue({
  success: true,
  executionId: 'test-exec',
  mode: 'full',
  schedulesProcessed: 1,
  resourcesStarted: 0,
  resourcesStopped: 0,
  resourcesFailed: 0,
  duration: 100,
  processedTenantIds: ['tenant-1'],
  checkedTenantIds: ['tenant-1'],
});
const mockExecutor = {
  registerHandler: mockRegisterHandler,
  execute: mockExecute,
};

vi.mock('./services/scheduler-service.js', () => ({
  runFullScan: vi.fn().mockResolvedValue({
    success: true,
    executionId: 'test-exec',
    mode: 'full',
    schedulesProcessed: 0,
    resourcesStarted: 0,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 100,
  }),
  runPartialScan: vi.fn().mockResolvedValue({
    success: true,
    executionId: 'test-exec',
    mode: 'partial',
    schedulesProcessed: 1,
    resourcesStarted: 0,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 50,
  }),
}));

vi.mock('./services/pg-service.js', () => ({
  getActiveTenants: vi.fn().mockResolvedValue([
    { id: 'tenant-1', name: 'Tenant One' },
  ]),
  getTenantSchedulerConfig: vi.fn().mockResolvedValue({ intervalMinutes: 60 }),
  getTenantJobConfig: vi.fn().mockResolvedValue({ intervalMinutes: 60, lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
  getSchedules: vi.fn().mockResolvedValue([]),
  getAccounts: vi.fn().mockResolvedValue([]),
  getScheduleById: vi.fn().mockResolvedValue(null),
  logExecution: vi.fn().mockResolvedValue(undefined),
}));

import { register } from './index.js';

describe('scheduler job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register cron as */5 * * * *', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockSchedule).toHaveBeenCalledWith(
      'scheduler-scan',
      '*/5 * * * *',
      {},
      { tz: 'UTC' }
    );
  });

  it('should register handler with executor', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockRegisterHandler).toHaveBeenCalledWith('scheduler-scan', expect.any(Function));
  });

  it('should call executor.execute scoped per due tenant on a cron tick', async () => {
    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);
    // Cron tick ({} payload) → scoped per-tenant scan, not an unscoped {} scan
    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', { triggeredBy: 'system', tenantId: 'tenant-1' });
  });

  it('should run a manual full-scan trigger immediately, bypassing interval gating', async () => {
    const pgService = await import('./services/pg-service.js');
    const recentRun = new Date(Date.now() - 1 * 60 * 1000).toISOString(); // 1 min ago (would be gated)
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValue({ intervalMinutes: 60, lastRunAt: recentRun });

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    const manual = { triggeredBy: 'web-ui', tenantId: 'tenant-9', userEmail: 'u@x' };
    await workCallback([{ id: 'job-1', data: manual }]);

    // Runs the payload as-is (no gating), and does NOT touch tenant interval config
    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', manual);
    expect(pgService.getActiveTenants).not.toHaveBeenCalled();
    expect(pgService.updateTenantJobLastRun).not.toHaveBeenCalled();
  });

  it('should run a manual partial-scan trigger immediately', async () => {
    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    const manual = { scheduleId: 'sched-1', tenantId: 'tenant-1', triggeredBy: 'web-ui' };
    await workCallback([{ id: 'job-1', data: manual }]);
    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', manual);
  });

  it('should harden scheduler-scan so an interrupted scan is discarded, not resurrected', async () => {
    await register(mockBoss, mockExecutor);
    // retryLimit:0 → no auto-rerun of a stale scan; bounded expireInSeconds so an
    // orphaned 'active' job is failed in minutes, not the 4h global default.
    expect(mockBoss.updateQueue).toHaveBeenCalledWith(
      'scheduler-scan',
      expect.objectContaining({ name: 'scheduler-scan', retryLimit: 0, expireInSeconds: expect.any(Number) })
    );
    const call = mockBoss.updateQueue.mock.calls.find((c: any[]) => c[0] === 'scheduler-scan');
    expect(call[1].expireInSeconds).toBeGreaterThan(120); // must exceed a real scan
  });

  it('should register a scheduler-reschedule drain consumer', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockBoss.createQueue).toHaveBeenCalledWith('scheduler-reschedule');
    const rescheduleWork = mockWork.mock.calls.find((c: any[]) => c[0] === 'scheduler-reschedule');
    expect(rescheduleWork).toBeDefined();
  });

  it('should skip tenant when interval has not elapsed', async () => {
    const pgService = await import('./services/pg-service.js');
    const recentRun = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: recentRun });

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);

    expect(pgService.updateTenantJobLastRun).not.toHaveBeenCalled();
  });

  it('should run tenant and update lastRunAt when interval has elapsed', async () => {
    const pgService = await import('./services/pg-service.js');
    const oldRun = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 min ago
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: oldRun });

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);

    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', expect.any(String));
  });

  it('should always run tenant when lastRunAt is null', async () => {
    const pgService = await import('./services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: null });

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);

    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', expect.any(String));
  });

  it('should still advance lastRunAt for a tenant with no schedules/accounts', async () => {
    const pgService = await import('./services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: null });
    // Empty tenant: the scan runs but reports no work.
    mockExecute.mockResolvedValueOnce({
      success: true,
      executionId: 'test-exec',
      mode: 'full',
      schedulesProcessed: 0,
      resourcesStarted: 0,
      resourcesStopped: 0,
      resourcesFailed: 0,
      duration: 100,
      processedTenantIds: [],
      checkedTenantIds: ['tenant-1'],
    });

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);

    // Regression guard: without this, an empty tenant's lastRunAt never advances and it
    // gets re-dispatched (a real ECS RunTask under the horizontal executor) every single tick.
    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', expect.any(String));
  });

  it('advances lastRunAt under the HORIZONTAL executor, which resolves to void (no SchedulerResult)', async () => {
    // THE production case: WORKER_ARCH=horizontal dispatches the scan to a separate
    // ephemeral ECS task and resolves execute() to `undefined` on exit 0 — the scan
    // result never crosses the process boundary. Gating lastRunAt on the return value
    // (processedTenantIds/checkedTenantIds) left it permanently null, so every tenant
    // was re-dispatched every tick forever. lastRunAt must advance on a clean resolve.
    const pgService = await import('./services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: null });
    mockExecute.mockResolvedValueOnce(undefined); // horizontal executor returns void

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);

    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', { triggeredBy: 'system', tenantId: 'tenant-1' });
    expect(pgService.updateTenantJobLastRun).toHaveBeenCalledWith('tenant-1', 'scheduler-cron', expect.any(String));
  });

  it('should not advance lastRunAt or abort the loop when executor.execute throws for a tenant', async () => {
    const pgService = await import('./services/pg-service.js');
    vi.mocked(pgService.getTenantJobConfig).mockResolvedValueOnce({ intervalMinutes: 60, lastRunAt: null });
    mockExecute.mockRejectedValueOnce(new Error('AccessDeniedException: not authorized to perform ecs:RunTask'));

    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    // Must not throw — an unhandled rejection here previously crashed the whole worker process.
    await expect(workCallback([{ id: 'job-1', data: {} }])).resolves.not.toThrow();

    expect(pgService.updateTenantJobLastRun).not.toHaveBeenCalled();
  });
});
