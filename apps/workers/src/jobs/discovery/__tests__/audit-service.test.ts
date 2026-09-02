import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeAuditLog } from '../services/audit-service.js';

describe('audit-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  it('should write a discovery.scan.started audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.started',
      action: 'scan_started',
      resourceId: 'scan-abc',
      status: 'info',
      severity: 'info',
      details: 'Discovery scan started for 3 accounts',
      metadata: { scanId: 'scan-abc', accountCount: 3 },
    });

    expect(mockConnect).toHaveBeenCalled();
    // Bound params, in order: id, tenantId, logId, timestamp, eventType, action,
    // user, userType, resourceType, resourceId, status, severity, details,
    // metadata, accountId, region, expiresAt, source. Dates are bound as ISO
    // strings (new Date().toISOString()), not Date instances.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        'tenant-123',
        expect.any(String), // id
        expect.any(String), // logId
        expect.any(String), // timestamp (ISO string)
        'discovery.scan.started',
        'scan_started',
        'system',
        'system',
        'discovery',
        'scan-abc',
        'info',
        'info',
        'Discovery scan started for 3 accounts',
        expect.any(String), // metadata JSON
      ]),
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should write a discovery.scan.completed audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.completed',
      action: 'scan_completed',
      resourceId: 'scan-abc',
      status: 'success',
      severity: 'info',
      details: 'Discovery scan completed: 500 resources across 3 accounts',
      metadata: { scanId: 'scan-abc', totalResources: 500, accountsSynced: 3, elapsedMs: 12345 },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['discovery.scan.completed']),
    );
  });

  it('should write a discovery.scan.failed audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.failed',
      action: 'scan_failed',
      resourceId: 'scan-abc',
      status: 'error',
      severity: 'high',
      details: 'Discovery scan failed: AssumeRole denied',
      metadata: { scanId: 'scan-abc', error: 'AssumeRole denied' },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['discovery.scan.failed', 'scan_failed']),
    );
  });

  it('should set 30-day TTL on expiresAt', async () => {
    const before = Date.now();

    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.started',
      action: 'scan_started',
      resourceId: 'scan-abc',
      status: 'info',
      severity: 'info',
      details: 'test',
    });

    const after = Date.now();
    // expiresAt is bound as an ISO string (new Date(...).toISOString()), not a
    // Date instance — find it by parsing every string param and taking the one
    // far enough in the future to be the 30-day TTL rather than "now".
    const params = mockQuery.mock.calls[0][1] as unknown[];
    const expiresAtMs = params
      .filter((arg): arg is string => typeof arg === 'string')
      .map((arg) => Date.parse(arg))
      .find((ms) => !Number.isNaN(ms) && ms > after);

    expect(expiresAtMs).toBeDefined();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
  });

  it('should not throw on query error (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      writeAuditLog({
        tenantId: 'tenant-123',
        eventType: 'discovery.scan.started',
        action: 'scan_started',
        resourceId: 'scan-abc',
        status: 'info',
        severity: 'info',
        details: 'test',
      }),
    ).resolves.toBeUndefined();

    expect(mockRelease).toHaveBeenCalled();
  });
});
