export type WsClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type WsServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'session_info'; sessionId: string; expiresAt: string };

export interface PtySessionOptions {
  sessionId: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  expiresAt: string;
}
