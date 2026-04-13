export interface ShellSession {
  id: string;
  tenantId: string;
  userId: string;
  accountId: string | null;
  accountName: string | null;
  region: string;
  status: 'active' | 'disconnected' | 'terminated';
  approvalMode: 'manual' | 'auto_read' | 'auto_all';
  startedAt: string;
  lastActiveAt: string;
  terminatedAt: string | null;
}

export interface ShellSessionCreateRequest {
  accountId?: string;
  region?: string;
}

export interface ShellSessionResponse {
  success: boolean;
  data?: ShellSession;
  error?: string;
}

export interface ShellSessionListResponse {
  success: boolean;
  data?: ShellSession[];
  totalCount?: number;
  error?: string;
}

/** Messages sent over the WebSocket between browser and shell-server */
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
