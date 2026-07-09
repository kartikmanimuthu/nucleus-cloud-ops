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

// ---------------------------------------------------------------------------
// Wire messages — what the web-ui actually enqueues into pg-boss.
//
// SECURITY: source credentials (apiToken) and potentially-huge fields
// (config, oldVectorKeys) must NOT travel through the job payload. They would be
// persisted in pgboss.job (+ its 7-day archive) in plaintext, and under
// WORKER_ARCH=horizontal serialized into the ECS containerOverrides command line
// (visible in DescribeTasks / the ECS console / CloudTrail). The wire message
// carries only identifiers; the handler re-hydrates `config` and `oldVectorKeys`
// from the data_sources row (encrypted at rest is a separate follow-up, but this
// keeps secrets out of the queue and the task launch API entirely).
// ---------------------------------------------------------------------------

interface BaseMessage {
  type: JobType;
  kbId: string;
  dsId: string;
  tenantId: string;
}

export interface FileUploadMessage extends BaseMessage {
  type: 'file-upload';
  // Upload-time, non-secret, bounded — safe to carry inline.
  stagingKey: string;
  fileName: string;
  mimeType: string;
}

export interface S3SyncMessage extends BaseMessage { type: 's3-sync'; }
export interface ConfluenceSyncMessage extends BaseMessage { type: 'confluence-sync'; }
export interface BitbucketSyncMessage extends BaseMessage { type: 'bitbucket-sync'; }

export type KBSyncMessage =
  | FileUploadMessage
  | S3SyncMessage
  | ConfluenceSyncMessage
  | BitbucketSyncMessage;
