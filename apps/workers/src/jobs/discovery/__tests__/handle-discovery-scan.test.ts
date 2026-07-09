import { describe, it, expect, vi, beforeEach } from 'vitest';

// Declared via vi.hoisted() (rather than plain top-level `const`) because this file's
// vi.mock() factories are hoisted above regular statements, and with six separate factories
// each referencing external consts, Vitest 2.1's hoisting transform doesn't reliably hoist
// the plain `const mock*` declarations along with them (TDZ ReferenceError at collection
// time). vi.hoisted() guarantees these are initialized before any factory runs.
const {
  mockGetTenantAccounts,
  mockUpdateAccountSyncStatus,
  mockWriteAuditLog,
  mockAssumeRole,
  mockRunInventoryScan,
  mockWriteResourcesToPg,
  mockSaveSyncStatus,
  mockReconcileStaleResources,
  mockLogger,
} = vi.hoisted(() => ({
  mockGetTenantAccounts: vi.fn(),
  mockUpdateAccountSyncStatus: vi.fn().mockResolvedValue(undefined),
  mockWriteAuditLog: vi.fn().mockResolvedValue(undefined),
  mockAssumeRole: vi.fn(),
  mockRunInventoryScan: vi.fn(),
  mockWriteResourcesToPg: vi.fn(),
  mockSaveSyncStatus: vi.fn().mockResolvedValue(undefined),
  mockReconcileStaleResources: vi.fn().mockResolvedValue(0),
  // createLogger builds a fresh closure per call (not memoized by module name — see
  // apps/workers/src/lib/logger.ts), so a logger obtained by calling the real createLogger
  // in this test would be a different instance than the one index.ts holds in its module-level
  // `log` const. Mock the module so both index.ts and this test share the same logger object.
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../services/account-service.js', () => ({
  getAllTenants: vi.fn().mockResolvedValue([]),
  getTenantAccounts: mockGetTenantAccounts,
  updateAccountSyncStatus: mockUpdateAccountSyncStatus,
}));

vi.mock('../services/audit-service.js', () => ({
  writeAuditLog: mockWriteAuditLog,
}));

vi.mock('../services/sts-service.js', () => ({
  assumeRole: mockAssumeRole,
}));

vi.mock('../services/scanner.js', () => ({
  runInventoryScan: mockRunInventoryScan,
}));

vi.mock('../services/pg-writer.js', () => ({
  writeResourcesToPg: mockWriteResourcesToPg,
  saveSyncStatus: mockSaveSyncStatus,
  reconcileStaleResources: mockReconcileStaleResources,
}));

vi.mock('../../scheduler/services/pg-service.js', () => ({
  getTenantJobConfig: vi.fn().mockResolvedValue({ period: 'daily', lastRunAt: null }),
  updateTenantJobLastRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { handleDiscoveryScan } from '../index.js';

const account = {
  id: 'acc-row-1',
  tenantId: 'tenant-1',
  accountId: 'acc-123',
  name: 'Prod',
  roleArn: 'arn:aws:iam::123:role/Nucleus',
  regions: ['us-east-1'],
  active: true,
};

const account2 = {
  id: 'acc-row-2',
  tenantId: 'tenant-1',
  accountId: 'acc-456',
  name: 'Staging',
  roleArn: 'arn:aws:iam::456:role/Nucleus',
  regions: ['us-east-1'],
  active: true,
};

describe('handleDiscoveryScan — reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAccounts.mockResolvedValue([account]);
    mockAssumeRole.mockResolvedValue({ credentials: {} });
    mockUpdateAccountSyncStatus.mockResolvedValue(undefined);
    mockSaveSyncStatus.mockResolvedValue(undefined);
    mockReconcileStaleResources.mockResolvedValue(0);
  });

  it('reconciles the account after a successful scan with resources', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [{ resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} }],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockWriteResourcesToPg).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledWith('tenant-1', 'acc-123', expect.stringMatching(/^scan-/));
  });

  it('reconciles the account even when the scan returns zero resources', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
  });

  it('reconciles the account even when the scan throws before any resources are written', async () => {
    mockAssumeRole.mockRejectedValue(new Error('assume role denied'));

    // With only one account in the tenant and that account's scan failing, accountsSynced
    // stays 0 and handleDiscoveryScan's pre-existing "all accounts failed" guard (unrelated
    // to reconciliation, out of scope for this task) rethrows after the per-account loop.
    // The reconciliation call under test happens inside the catch block, before that rethrow.
    await expect(
      handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' }),
    ).rejects.toThrow('assume role denied');

    expect(mockWriteResourcesToPg).not.toHaveBeenCalled();
    expect(mockReconcileStaleResources).toHaveBeenCalledOnce();
    expect(mockReconcileStaleResources).toHaveBeenCalledWith('tenant-1', 'acc-123', expect.stringMatching(/^scan-/));
  });

  it('logs a warning when reconciliation stales rows after an empty scan', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });
    mockReconcileStaleResources.mockResolvedValue(5);

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale'),
      expect.objectContaining({ tenantId: 'tenant-1', accountId: 'acc-123', staleCount: 5 }),
    );
  });

  it('does not warn when reconciliation stales nothing after an empty scan', async () => {
    mockRunInventoryScan.mockResolvedValue({
      resources: [],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });
    mockReconcileStaleResources.mockResolvedValue(0);

    await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' });

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('continues to the next account when reconciliation throws on the success path', async () => {
    mockGetTenantAccounts.mockResolvedValue([account, account2]);
    mockRunInventoryScan.mockResolvedValue({
      resources: [{ resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} }],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });
    mockReconcileStaleResources.mockRejectedValueOnce(new Error('db error during reconcile'));

    await expect(
      handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' }),
    ).resolves.toBeUndefined();

    // Both accounts were scanned and written despite account 1's reconcile failing.
    expect(mockWriteResourcesToPg).toHaveBeenCalledTimes(2);
    expect(mockReconcileStaleResources).toHaveBeenCalledTimes(2);

    // Reconcile failure is logged but does not propagate — a reconcile-only failure after
    // a successful scan should not flip the account to "error" status.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Reconciliation failed'),
      expect.objectContaining({ tenantId: 'tenant-1', accountId: 'acc-123' }),
    );
    expect(mockUpdateAccountSyncStatus).toHaveBeenCalledWith(
      'tenant-1',
      'acc-123',
      expect.objectContaining({ lastSyncStatus: 'success' }),
    );
    expect(mockUpdateAccountSyncStatus).toHaveBeenCalledWith(
      'tenant-1',
      'acc-456',
      expect.objectContaining({ lastSyncStatus: 'success' }),
    );
  });

  it('continues to the next account when reconciliation also throws on the error path', async () => {
    mockGetTenantAccounts.mockResolvedValue([account, account2]);
    mockAssumeRole.mockImplementation(async (_roleArn: string, accountId: string) => {
      if (accountId === 'acc-123') throw new Error('assume role denied');
      return { credentials: {} };
    });
    mockReconcileStaleResources.mockRejectedValueOnce(new Error('db error during reconcile'));
    mockRunInventoryScan.mockResolvedValue({
      resources: [{ resourceType: 'ec2_instances', resourceId: 'i-1', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} }],
      regionsScanned: 1,
      servicesScanned: 1,
      elapsedMs: 10,
      errors: [],
    });

    await expect(
      handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' }),
    ).resolves.toBeUndefined();

    // Account 2 must still be processed even though account 1 failed both its scan
    // and its (fail-open) reconciliation.
    expect(mockRunInventoryScan).toHaveBeenCalledOnce();
    expect(mockWriteResourcesToPg).toHaveBeenCalledOnce();
    expect(mockUpdateAccountSyncStatus).toHaveBeenCalledWith(
      'tenant-1',
      'acc-456',
      expect.objectContaining({ lastSyncStatus: 'success' }),
    );
    expect(mockUpdateAccountSyncStatus).toHaveBeenCalledWith(
      'tenant-1',
      'acc-123',
      expect.objectContaining({ lastSyncStatus: 'error' }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Reconciliation failed'),
      expect.objectContaining({ tenantId: 'tenant-1', accountId: 'acc-123' }),
    );
  });

  it('includes the scan error in the warning when reconciliation stales rows on the error path', async () => {
    mockAssumeRole.mockRejectedValue(new Error('assume role denied'));
    mockReconcileStaleResources.mockResolvedValue(5);

    await expect(
      handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' }),
    ).rejects.toThrow('assume role denied');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale'),
      expect.objectContaining({
        tenantId: 'tenant-1',
        accountId: 'acc-123',
        staleCount: 5,
        scanError: 'assume role denied',
      }),
    );
  });
});
