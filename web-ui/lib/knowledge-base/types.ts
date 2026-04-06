/**
 * Knowledge Base Module — Type Definitions
 *
 * Data model for knowledge bases and their data sources.
 * DynamoDB single-table design keys:
 *   KnowledgeBase: PK=TENANT#<tenantId>, SK=KB#<kbId>
 *   DataSource:    PK=KB#<kbId>,         SK=DATASOURCE#<dsId>
 */

// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

export type KnowledgeBaseStatus = 'active' | 'inactive';
export type DataSourceType = 'file-upload' | 's3-bucket' | 'confluence' | 'bitbucket';
export type DataSourceStatus = 'pending' | 'syncing' | 'synced' | 'error';

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  status: KnowledgeBaseStatus;
  vectorCount: number;
  dataSourceCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface DataSource {
  id: string;
  knowledgeBaseId: string;
  name: string;
  sourceType: DataSourceType;
  status: DataSourceStatus;
  config: DataSourceConfig;
  vectorCount: number;
  vectorKeys: string[];
  lastSyncAt?: string;
  lastSyncError?: string;
  lastErrorMessage?: string;
  lastErrorDetail?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Data source config variants
// ---------------------------------------------------------------------------

export interface FileUploadConfig {
  fileName: string;
  fileSize: number;
  mimeType: string;
  s3Key: string;
  chunkCount: number;
}

export interface S3BucketConfig {
  bucketName: string;
  prefix?: string;
  filePatterns?: string[];
  region?: string;
}

export interface ConfluenceConfig {
  spaceKey: string;
  pageIds?: string[];
  mcpServerId: string;
  baseUrl: string;
  /**
   * Atlassian API token for authentication.
   * Leave empty for public Confluence spaces only.
   */
  apiToken?: string;
  /** Email address associated with the API token (required when apiToken is set). */
  email?: string;
}

export interface BitbucketConfig {
  workspace: string;
  /** Optional — if omitted, all repos in the workspace are scraped. */
  project?: string;
  /** Optional — if omitted, all repos in the workspace/project are scraped. */
  repoSlug?: string;
  /** Optional — defaults to main → master → repo default branch. */
  branch?: string;
  paths?: string[];
  /**
   * SENSITIVE — Atlassian API token.
   * Callers MUST mask this field before returning it in API responses.
   */
  apiToken: string;
  /** Atlassian account email associated with the API token. */
  email: string;
  baseUrl?: string;
}

export type DataSourceConfig =
  | FileUploadConfig
  | S3BucketConfig
  | ConfluenceConfig
  | BitbucketConfig;

// ---------------------------------------------------------------------------
// Input types (for create / update operations)
// ---------------------------------------------------------------------------

export interface CreateKBInput {
  name: string;
  description?: string;
}

export interface CreateDataSourceInput {
  name: string;
  sourceType: DataSourceType;
  config: DataSourceConfig;
}

// ---------------------------------------------------------------------------
// Chunking & embedding helpers
// ---------------------------------------------------------------------------

export interface KBChunk {
  /** Raw content hash (SHA-256 of un-prefixed text) used for deduplication. */
  contentHash: string;
  /** Prefixed text sent to the embedding model. */
  text: string;
  index: number;
  total: number;
}

export interface VectorMetadata {
  knowledgeBaseId: string;
  dataSourceId: string;
  sourceType: string;
  documentName: string;
  /** Stored as string — S3 Vectors metadata values must be strings. */
  chunkIndex: string;
  /** Stored as string — S3 Vectors metadata values must be strings. */
  totalChunks: string;
  contentHash: string;
  text_content: string;
  s3Key?: string;
  confluencePageId?: string;
  bitbucketRepo?: string;
  bitbucketPath?: string;
}
