// ---------------------------------------------------------------------------
// Job payload types for KB sync
// ---------------------------------------------------------------------------

export type JobType = 'file-upload' | 's3-sync' | 'confluence-sync' | 'bitbucket-sync';

export interface BaseJob {
  type: JobType;
  kbId: string;
  dsId: string;
  tenantId: string;
  oldVectorKeys?: string[];
}

export interface FileUploadJob extends BaseJob {
  type: 'file-upload';
  stagingKey: string;
  fileName: string;
  mimeType: string;
}

export interface S3SyncJob extends BaseJob {
  type: 's3-sync';
  config: { bucketName: string; prefix?: string; filePatterns?: string[]; region?: string };
}

export interface ConfluenceSyncJob extends BaseJob {
  type: 'confluence-sync';
  config: {
    spaceKey: string;
    pageIds?: string[];
    baseUrl: string;
    email?: string;
    apiToken?: string;
  };
}

export interface BitbucketSyncJob extends BaseJob {
  type: 'bitbucket-sync';
  config: {
    workspace: string;
    project?: string;
    repoSlug?: string;
    branch?: string;
    paths?: string[];
    apiToken: string;
    email: string;
    baseUrl?: string;
  };
}

export type KBSyncJob = FileUploadJob | S3SyncJob | ConfluenceSyncJob | BitbucketSyncJob;
