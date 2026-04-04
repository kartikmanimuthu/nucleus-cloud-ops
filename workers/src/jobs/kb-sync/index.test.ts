import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();

const mockBoss = {
  work: mockWork,
  send: vi.fn(),
  schedule: vi.fn(),
} as any;

vi.mock('./handlers/file-upload.js', () => ({ handleFileUpload: vi.fn().mockResolvedValue(['key1']) }));
vi.mock('./handlers/s3-sync.js', () => ({ handleS3Sync: vi.fn().mockResolvedValue(['key2']) }));
vi.mock('./handlers/confluence-sync.js', () => ({ handleConfluenceSync: vi.fn().mockResolvedValue(['key3']) }));
vi.mock('./handlers/bitbucket-sync.js', () => ({ handleBitbucketSync: vi.fn().mockResolvedValue(['key4']) }));
vi.mock('./lib/vector-store.js', () => ({
  getDataSource: vi.fn().mockResolvedValue({ vectorCount: 0, vectorKeys: [], status: 'synced' }),
  updateDS: vi.fn().mockResolvedValue(undefined),
  updateKBVectorCount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./lib/embedding.js', () => ({
  deleteOldVectors: vi.fn().mockResolvedValue(undefined),
  embedAndStore: vi.fn().mockResolvedValue([]),
  getEmbedding: vi.fn().mockResolvedValue([]),
}));

import { register } from './index.js';

describe('kb-sync job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register kb-sync worker with teamSize 3', async () => {
    await register(mockBoss);

    expect(mockWork).toHaveBeenCalledWith(
      'kb-sync',
      expect.objectContaining({ batchSize: 3 }),
      expect.any(Function),
    );
  });
});
