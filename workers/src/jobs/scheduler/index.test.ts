import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();
const mockSchedule = vi.fn();

const mockBoss = {
  work: mockWork,
  schedule: mockSchedule,
  send: vi.fn(),
  createQueue: vi.fn().mockResolvedValue(undefined),
} as any;

const mockRegisterHandler = vi.fn();
const mockExecute = vi.fn().mockResolvedValue(undefined);
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

  it('should register cron as 0 * * * *', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockSchedule).toHaveBeenCalledWith(
      'scheduler-scan',
      '0 * * * *',
      {},
      { tz: 'UTC' }
    );
  });

  it('should register handler with executor', async () => {
    await register(mockBoss, mockExecutor);
    expect(mockRegisterHandler).toHaveBeenCalledWith('scheduler-scan', expect.any(Function));
  });

  it('should call executor.execute in boss.work callback', async () => {
    await register(mockBoss, mockExecutor);
    const workCallback = mockWork.mock.calls[0][2];
    await workCallback([{ id: 'job-1', data: {} }]);
    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', {});
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
});
