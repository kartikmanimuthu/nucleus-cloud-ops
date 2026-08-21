'use client';

/**
 * TanStack Query hooks for tenant roles (settings → roles). Fetches inlined
 * (no client service class). Mutations invalidate the roles cache on success.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PermissionSet } from '@/lib/rbac/types';
import type { SubjectOverrides } from '@/lib/rbac/role-subject-overrides';

export interface PredefinedRole {
    id: string;
    name: string;
    permissions: PermissionSet;
    /** Subject-level exceptions to `permissions`. Empty object when there are none. */
    overrides: SubjectOverrides;
    level: number;
    predefined: true;
}

export interface CustomRole {
    id: string;
    tenantId: string;
    name: string;
    permissions: PermissionSet;
    /** Subject-level exceptions to `permissions`. Empty object when there are none. */
    overrides: SubjectOverrides;
    level: number;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}

interface RolesData {
    predefined: PredefinedRole[];
    custom: CustomRole[];
}

const rolesKey = ['settings', 'roles'] as const;

export function useRoles() {
    return useQuery({
        queryKey: rolesKey,
        queryFn: async (): Promise<RolesData> => {
            const res = await fetch('/api/settings/roles');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? 'Failed to load roles.');
            }
            return {
                predefined: json.data.predefined ?? [],
                custom: json.data.custom ?? [],
            };
        },
    });
}

/** Create (no id) or update (with id) a custom role. */
export function useSaveRole() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({
            id,
            name,
            permissions,
            overrides,
        }: {
            id?: string;
            name: string;
            permissions: PermissionSet;
            overrides: SubjectOverrides;
        }) => {
            const res = await fetch(
                id ? `/api/settings/roles/${id}` : '/api/settings/roles',
                {
                    method: id ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, permissions, overrides }),
                },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(
                    json.error ?? (id ? 'Failed to update role.' : 'Failed to create role.'),
                );
            }
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: rolesKey }),
    });
}

export function useDeleteRole() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/roles/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? 'Failed to delete role.');
            }
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: rolesKey }),
    });
}
