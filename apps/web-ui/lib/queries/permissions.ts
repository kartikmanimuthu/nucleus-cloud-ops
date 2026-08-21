'use client';

/**
 * TanStack Query hooks for the RBAC/ABAC admin surface.
 *
 * Every mutation here invalidates BOTH `queryKeys.rbac.all` and
 * `queryKeys.ability.all`: a permission change alters the registry AND the
 * caller's own compiled ability, and refreshing one without the other leaves the
 * UI showing controls the API will refuse.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from './query-keys';

export interface PrincipalAttributeDef {
    key: string;
    label: string;
    valueType: 'string' | 'number' | 'boolean' | 'string[]' | 'date';
}

export interface MemberAttributes {
    userId: string;
    email: string;
    /** Which keys may be assigned at all — driven by rbac_principal_attributes. */
    assignable: PrincipalAttributeDef[];
    values: Record<string, unknown>;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? fallback);
    return json.data as T;
}

/** Principal attributes assigned to one member, plus what may be assigned. */
export function useMemberAttributes(memberId: string | null) {
    return useQuery({
        queryKey: queryKeys.rbac.userAttributes(memberId ?? 'none'),
        enabled: Boolean(memberId),
        queryFn: async (): Promise<MemberAttributes> => {
            const res = await fetch(`/api/settings/members/${memberId}/attributes`);
            return readJson<MemberAttributes>(res, 'Failed to load member attributes.');
        },
    });
}

export function useUpdateMemberAttributes(memberId: string | null) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ values, reason }: { values: Record<string, unknown>; reason?: string }) => {
            const res = await fetch(`/api/settings/members/${memberId}/attributes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ values, reason }),
            });
            return readJson(res, 'Failed to update member attributes.');
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.rbac.all });
            // The change bumps the tenant's RBAC version, so the caller's own
            // ability may differ too — propagation is bounded at ~5s server-side.
            qc.invalidateQueries({ queryKey: queryKeys.ability.all });
        },
    });
}
