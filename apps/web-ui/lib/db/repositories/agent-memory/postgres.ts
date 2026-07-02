import { getTenantClient } from '@/lib/db/pg-config';
import { categoryFromNamespace, KNOWN_CATEGORIES } from '@/lib/agent-memory/category';
import type { MemoryCategory } from '@/lib/agent-memory/category';
import type { MemoryKind } from '@/lib/agent/memory/types';
import type {
    IAgentMemoryRepository,
    AgentMemoryRecord,
    AgentMemoryFilters,
    AgentMemoryPage,
    AgentMemorySortField,
} from './interface';

type MemoryRow = {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    key: string;
    value: unknown;
    kind: MemoryKind;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
};

function asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
}

function toRecord(row: MemoryRow): AgentMemoryRecord {
    const value = (row.value && typeof row.value === 'object' ? row.value : {}) as Record<
        string,
        unknown
    >;
    return {
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId,
        namespace: row.namespace,
        category: categoryFromNamespace(row.namespace),
        kind: row.kind,
        key: row.key,
        fact: asString(value.fact) ?? '',
        source: asString(value.source),
        confidence: asString(value.confidence),
        value,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
    };
}

/** Prisma `where` predicate matching a single derived category via its namespace prefix. */
function categoryClause(c: MemoryCategory): Record<string, unknown> {
    if (c === 'other') {
        return {
            NOT: {
                OR: KNOWN_CATEGORIES.flatMap((k) => [
                    { namespace: { startsWith: `${k}/` } },
                    { namespace: k },
                ]),
            },
        };
    }
    return { OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] };
}

/**
 * Maps a sort field to a Prisma `orderBy`. `category` is derived from the
 * namespace prefix, so it sorts on `namespace` (close enough to alphabetical
 * category order). Defaults to newest-updated first when no sort is requested.
 */
function orderByClause(
    sortBy: AgentMemorySortField | undefined,
    sortDir: 'asc' | 'desc' | undefined
): Record<string, 'asc' | 'desc'> {
    if (!sortBy) return { updatedAt: 'desc' };
    const dir = sortDir ?? 'asc';
    const column = sortBy === 'category' ? 'namespace' : sortBy;
    return { [column]: dir };
}

export class AgentMemoryPostgresRepository implements IAgentMemoryRepository {
    async listByTenant(filters: AgentMemoryFilters): Promise<AgentMemoryPage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        const and: unknown[] = [];

        const categories =
            filters.categories?.length ? filters.categories : filters.category ? [filters.category] : [];
        if (categories.length === 1) {
            and.push(categoryClause(categories[0]));
        } else if (categories.length > 1) {
            and.push({ OR: categories.map(categoryClause) });
        }

        if (filters.search) {
            and.push({
                OR: [
                    { key: { contains: filters.search, mode: 'insensitive' } },
                    // JSON path filter on value.fact (Postgres). string_contains is
                    // case-sensitive in Prisma — acceptable for a fact substring match.
                    { value: { path: ['fact'], string_contains: filters.search } },
                ],
            });
        }

        if (and.length) where.AND = and;

        const [rows, total] = await Promise.all([
            db.agentMemory.findMany({
                where,
                orderBy: orderByClause(filters.sortBy, filters.sortDir),
                skip,
                take: limit,
            }),
            db.agentMemory.count({ where }),
        ]);

        return { memories: (rows as MemoryRow[]).map(toRecord), total };
    }

    async getById(tenantId: string, id: string): Promise<AgentMemoryRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.agentMemory.findFirst({ where: { id, tenantId } });
        return row ? toRecord(row as MemoryRow) : null;
    }

    async deleteById(tenantId: string, id: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.agentMemory.deleteMany({ where: { id, tenantId } });
    }
}
