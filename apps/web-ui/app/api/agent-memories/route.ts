import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { MemoryCategory } from '@/lib/agent-memory/category';
import type { AgentMemorySortField, SortDirection } from '@/lib/db/repositories/agent-memory/interface';

const VALID_CATEGORIES = new Set<MemoryCategory>(['infra', 'user', 'patterns', 'errors', 'other']);
const VALID_SORT_FIELDS = new Set<AgentMemorySortField>(['category', 'key', 'createdAt', 'updatedAt', 'expiresAt']);

export async function GET(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Memory');
        if (authError) return authError;

        const { searchParams } = new URL(request.url);
        const categories = (searchParams.get('category') ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter((c): c is MemoryCategory => VALID_CATEGORIES.has(c as MemoryCategory));

        const sortParam = searchParams.get('sort');
        const sortBy = sortParam && VALID_SORT_FIELDS.has(sortParam as AgentMemorySortField)
            ? (sortParam as AgentMemorySortField)
            : undefined;
        const sortDir: SortDirection = searchParams.get('dir') === 'desc' ? 'desc' : 'asc';

        const repo = getAgentMemoryRepository();
        const result = await repo.listByTenant({
            tenantId,
            categories,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '100', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
            sortBy,
            sortDir: sortBy ? sortDir : undefined,
        });

        return NextResponse.json({ success: true, data: result.memories, total: result.total });
    } catch (error: unknown) {
        console.error('API - Error fetching agent memories:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch memories';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
