import type { MemoryCategory } from '@/lib/agent-memory/category';
import type { MemoryKind } from '@/lib/agent/memory/types';
import type { PrismaRowFilter } from '@/lib/db/pg-config';

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
    supersededById: string | null;
    supersededAt: string | null;
    sourceThreadId: string | null;
}

/** Columns the list view can be sorted by (server-side). */
export type AgentMemorySortField = 'category' | 'key' | 'createdAt' | 'updatedAt' | 'expiresAt';
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
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
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
