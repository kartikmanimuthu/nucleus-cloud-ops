import type { MemoryCategory } from '@/lib/agent-memory/category';

export interface AgentMemoryRecord {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    category: MemoryCategory;
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

export interface AgentMemoryFilters {
    tenantId: string;
    category?: MemoryCategory;
    /** Multi-select category filter; takes precedence over `category` when non-empty. */
    categories?: MemoryCategory[];
    search?: string;
    page?: number;
    limit?: number;
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
