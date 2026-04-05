import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockSchedule = vi.fn().mockResolvedValue(undefined);
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue('job-id-123');

const mockBoss = {
  createQueue: mockCreateQueue,
  schedule: mockSchedule,
  work: mockWork,
  send: mockSend,
};

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

describe('register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates both queues', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockCreateQueue).toHaveBeenCalledWith('discovery-fan-out');
    expect(mockCreateQueue).toHaveBeenCalledWith('discovery-scan');
  });

  it('schedules daily cron for fan-out', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockSchedule).toHaveBeenCalledWith(
      'discovery-fan-out',
      '0 2 * * *',
      {},
      { tz: 'UTC' }
    );
  });

  it('registers work handlers for both queues', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockWork).toHaveBeenCalledWith('discovery-fan-out', { batchSize: 1 }, expect.any(Function));
    expect(mockWork).toHaveBeenCalledWith('discovery-scan', { batchSize: 1 }, expect.any(Function));
  });
});

describe('fan-out handler', () => {
  it('sends one discovery-scan job per tenant with singletonKey', async () => {
    vi.clearAllMocks();
    const { register } = await import('../index.js');
    await register(mockBoss as any);

    const fanOutCall = mockWork.mock.calls.find(c => c[0] === 'discovery-fan-out');
    const handler = fanOutCall![2];
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-1', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
    );
    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-2', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-2' })
    );
  });
});
