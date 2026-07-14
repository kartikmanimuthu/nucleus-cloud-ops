'use client';

/**
 * TanStack Query hooks for the Agent Memory module. Mirrors the certificates
 * hooks: each read parses the `{ success, data }` envelope and throws on
 * failure; the delete mutation invalidates `queryKeys.agentMemories.all`.
 * Toasts are fired at call sites via `sonner`, not here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type { MemoryCategory } from '@/lib/agent-memory/category';
import type { MemoryKind } from '@/lib/agent/memory/types';

export interface MemoryRow {
    id: string;
    userId: string;
    namespace: string;
    category: MemoryCategory;
    key: string;
    fact: string;
    source: string | null;
    confidence: string | null;
    value: Record<string, unknown>;
    kind: MemoryKind;
    sourceThreadId: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    supersededById: string | null;
    supersededAt: string | null;
}

export type MemorySortField = 'category' | 'key' | 'createdAt' | 'updatedAt' | 'expiresAt';

export interface MemoryFilters {
    category?: MemoryCategory;
    categories?: MemoryCategory[];
    search?: string;
    page?: number;
    limit?: number;
    sortBy?: MemorySortField;
    sortDir?: 'asc' | 'desc';
}

export function useAgentMemories(filters?: MemoryFilters) {
    return useQuery({
        queryKey: queryKeys.agentMemories.list(filters),
        queryFn: async (): Promise<{ data: MemoryRow[]; total: number }> => {
            const params = new URLSearchParams();
            // The UI passes `undefined` for the All tab, so only real categories arrive here.
            if (filters?.category) params.set('category', filters.category);
            if (filters?.categories?.length) params.set('category', filters.categories.join(','));
            if (filters?.search?.trim()) params.set('search', filters.search.trim());
            if (filters?.sortBy) {
                params.set('sort', filters.sortBy);
                params.set('dir', filters.sortDir ?? 'asc');
            }
            params.set('limit', String(filters?.limit ?? 100));
            params.set('page', String(filters?.page ?? 1));

            const res = await fetch(`/api/agent-memories?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load memories');
            }
            return { data: json.data as MemoryRow[], total: json.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

// Intentionally provided for future per-record detail fetching; not wired into the UI yet
// (the detail dialog currently reads from the already-fetched list row to avoid a second round-trip).
export function useAgentMemory(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.agentMemories.detail(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<MemoryRow> => {
            const res = await fetch(`/api/agent-memories/${id}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load memory');
            }
            return json.data as MemoryRow;
        },
    });
}

export function useDeleteAgentMemory() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            const res = await fetch(`/api/agent-memories/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to delete memory');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.agentMemories.all });
        },
    });
}

/**
 * Fetch every memory in the tenant for export-all, paging through
 * GET /api/agent-memories until the known `total` is reached. Safety-capped at
 * MAX_PAGES so an unexpected runaway cannot loop forever; callers compare
 * `memories.length < total` to detect truncation and warn. Not a hook — call
 * from an event handler, not render.
 */
export async function fetchAllAgentMemories(): Promise<{ memories: MemoryRow[]; total: number }> {
    const LIMIT = 500;
    const MAX_PAGES = 100;
    const memories: MemoryRow[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(`/api/agent-memories?limit=${LIMIT}&page=${page}&sort=createdAt&dir=asc`);
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.error || 'Failed to load memories');
        }
        const rows = json.data as MemoryRow[];
        total = json.total ?? 0;
        memories.push(...rows);
        if (rows.length < LIMIT || memories.length >= total) break;
    }
    return { memories, total };
}
