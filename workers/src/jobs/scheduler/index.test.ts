import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();
const mockSchedule = vi.fn();

const mockBoss = {
  work: mockWork,
  schedule: mockSchedule,
  send: vi.fn(),
  createQueue: vi.fn().mockResolvedValue(undefined),
} as any;

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
    await register(mockBoss);

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
});
