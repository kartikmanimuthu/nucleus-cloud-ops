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

import { createBoss } from './boss.js';

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
