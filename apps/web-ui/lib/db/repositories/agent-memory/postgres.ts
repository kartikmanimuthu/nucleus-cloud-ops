import { getTenantClient } from '@/lib/db/pg-config';
import { categoryFromNamespace, KNOWN_CATEGORIES } from '@/lib/agent-memory/category';
import type {
    IAgentMemoryRepository,
    AgentMemoryRecord,
    AgentMemoryFilters,
    AgentMemoryPage,
} from './interface';

type MemoryRow = {
    id: string;
    tenantId: string;
    userId: string;
    namespace: string;
    key: string;
    value: unknown;
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

export class AgentMemoryPostgresRepository implements IAgentMemoryRepository {
    async listByTenant(filters: AgentMemoryFilters): Promise<AgentMemoryPage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        const and: unknown[] = [];

        if (filters.category && filters.category !== 'other') {
            const c = filters.category;
            and.push({ OR: [{ namespace: { startsWith: `${c}/` } }, { namespace: c }] });
        } else if (filters.category === 'other') {
            and.push({
                NOT: {
                    OR: KNOWN_CATEGORIES.flatMap((c) => [
                        { namespace: { startsWith: `${c}/` } },
                        { namespace: c },
                    ]),
                },
            });
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
                orderBy: { updatedAt: 'desc' },
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
