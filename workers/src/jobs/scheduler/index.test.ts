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

// Mock the scheduler service
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

import { register } from './index.js';

describe('scheduler job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register cron schedule and worker', async () => {
    await register(mockBoss, mockExecutor);

    // Should schedule a cron
    expect(mockSchedule).toHaveBeenCalledWith(
      'scheduler-scan',
      '*/30 * * * *',
      expect.any(Object),
      expect.any(Object),
    );

    // Should register a worker
    expect(mockWork).toHaveBeenCalledWith(
      'scheduler-scan',
      expect.objectContaining({ batchSize: 1 }),
      expect.any(Function),
    );
  });

  it('should register handler with executor', async () => {
    await register(mockBoss, mockExecutor);

    expect(mockRegisterHandler).toHaveBeenCalledWith('scheduler-scan', expect.any(Function));
  });

  it('should call executor.execute in boss.work callback', async () => {
    await register(mockBoss, mockExecutor);

    // Extract the boss.work callback and invoke it
    const workCallback = mockWork.mock.calls[0][2];
    const fakeJob = { id: 'job-1', data: { triggeredBy: 'system' } };
    await workCallback([fakeJob]);

    expect(mockExecute).toHaveBeenCalledWith('scheduler-scan', fakeJob.data);
  });
});
