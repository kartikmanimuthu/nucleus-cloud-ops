import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg-boss', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    })),
  };
});

import { createBoss, buildBossOptions, resolvePollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS } from './boss.js';

describe('createBoss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a pg-boss instance with DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    const boss = createBoss();
    expect(boss).toBeDefined();
    expect(boss.start).toBeDefined();
    expect(boss.stop).toBeDefined();
  });
});

describe('resolvePollIntervalSeconds', () => {
  it('defaults when unset', () => {
    expect(resolvePollIntervalSeconds(undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it('defaults on garbage / non-positive input', () => {
    expect(resolvePollIntervalSeconds('abc')).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolvePollIntervalSeconds('0')).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolvePollIntervalSeconds('-3')).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it('honors a valid override', () => {
    expect(resolvePollIntervalSeconds('3')).toBe(3);
  });

  it('clamps to the pg-boss 0.5s minimum', () => {
    expect(resolvePollIntervalSeconds('0.1')).toBe(0.5);
  });
});

describe('buildBossOptions', () => {
  it('sets a sub-2s pollingIntervalSeconds so cross-process job pickup is near real-time', () => {
    const opts = buildBossOptions('postgresql://localhost:5432/test');
    expect(opts.pollingIntervalSeconds).toBeDefined();
    // The whole point of the fix: faster than pg-boss's 2s default.
    expect(opts.pollingIntervalSeconds as number).toBeLessThan(2);
    expect(opts.connectionString).toBe('postgresql://localhost:5432/test');
  });
});
