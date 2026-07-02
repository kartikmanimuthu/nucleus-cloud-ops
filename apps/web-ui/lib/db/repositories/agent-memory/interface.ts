import type { MemoryCategory } from '@/lib/agent-memory/category';
import type { MemoryKind } from '@/lib/agent/memory/types';

export interface AgentMemoryRecord {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    category: MemoryCategory;
    kind: MemoryKind;
    key: string;
    fact: string;
    source: string | null;
    confidence: string | null;
    /** Full raw `value` JSON for the detail view. */
    value: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

/** Columns the list view can be sorted by (server-side). */
export type AgentMemorySortField = 'category' | 'key' | 'createdAt' | 'expiresAt';
export type SortDirection = 'asc' | 'desc';

export interface AgentMemoryFilters {
    tenantId: string;
    category?: MemoryCategory;
    /** Multi-select category filter; takes precedence over `category` when non-empty. */
    categories?: MemoryCategory[];
    search?: string;
    page?: number;
    limit?: number;
    /** Sort column; defaults to most-recently-updated first when omitted. */
    sortBy?: AgentMemorySortField;
    sortDir?: SortDirection;
}

export interface AgentMemoryPage {
    memories: AgentMemoryRecord[];
    total: number;
}

export interface IAgentMemoryRepository {
    listByTenant(filters: AgentMemoryFilters): Promise<AgentMemoryPage>;
    getById(tenantId: string, id: string): Promise<AgentMemoryRecord | null>;
    deleteById(tenantId: string, id: string): Promise<void>;
}
