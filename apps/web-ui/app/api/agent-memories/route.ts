import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { MemoryCategory } from '@/lib/agent-memory/category';

const VALID_CATEGORIES = new Set<MemoryCategory>(['infra', 'user', 'patterns', 'errors', 'other']);

export async function GET(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Memory');
        if (authError) return authError;

        const { searchParams } = new URL(request.url);
        const rawCategory = searchParams.get('category');
        const category =
            rawCategory && VALID_CATEGORIES.has(rawCategory as MemoryCategory)
                ? (rawCategory as MemoryCategory)
                : undefined;

        const repo = getAgentMemoryRepository();
        const result = await repo.listByTenant({
            tenantId,
            category,
            search: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '100', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
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
