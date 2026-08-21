'use client';

/**
 * TanStack Query hooks for the permission registry (Settings → Access Control).
 *
 * Every mutation invalidates THREE caches, matching lib/queries/permissions.ts:
 *   · queryKeys.rbac.all     — the registry the admin screens render from
 *   · queryKeys.ability.all  — the caller's OWN compiled ability, which the
 *                              registry change may have altered
 *   · ['settings', 'roles']  — the roles screen renders its grid from the
 *                              registry, and its cache key predates queryKeys
 *
 * Refreshing one without the others leaves a screen showing controls the API
 * will refuse, which is the exact divergence this feature exists to remove.
 *
 * Type-only imports from lib/rbac/registry-admin are erased at build time, so
 * no server code reaches the client bundle through them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from './query-keys';
import type { AdminRegistry } from '@/lib/rbac/registry-admin';

export type { AdminActionRow, AdminModuleRow, AdminSubjectRow, AdminRegistry } from '@/lib/rbac/registry-admin';

export interface PermissionInput {
    key: string;
    label: string;
    description?: string | null;
    aliasOfKey?: string | null;
    isDangerous?: boolean;
    sortOrder?: number;
}

export interface ModuleFormInput {
    key: string;
    label: string;
    description?: string | null;
    icon?: string | null;
    navPath?: string | null;
    sortOrder?: number;
    enabled?: boolean;
    /** Verb keys that become grantable cells on this module. */
    actionKeys: string[];
    /** Subject keys this module covers. */
    subjectKeys: string[];
    /**
     * Confirms revoking grants whose cell is being removed. The API refuses
     * without it, because `grantable: false` does not stop an existing rule
     * compiling — the grant would stay live with no checkbox to revoke it.
     */
    force?: boolean;
    reason?: string;
}

export interface ModuleWriteResult {
    id: string;
    /** Subject-level rules written to preserve access across a remap. */
    materializedRules: number;
    /** Module-level rules deleted because their cell stopped being grantable. */
    revokedRules: number;
}

/**
 * The API distinguishes three failure kinds by status, and callers need the
 * distinction: 403 means "you may not" (a built-in row), 409 means "this is in
 * use" (the force-confirmable case), 400 means the input was invalid. Throwing a
 * plain Error would collapse them into one indistinguishable message.
 */
export class RegistryRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'RegistryRequestError';
        this.status = status;
    }

    /** True when the API is offering to proceed if the caller confirms. */
    get isConfirmable(): boolean {
        return this.status === 409;
    }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
        throw new RegistryRequestError(json?.error ?? fallback, res.status);
    }
    return json.data as T;
}

export function useAdminRegistry() {
    return useQuery({
        queryKey: queryKeys.rbac.registry(),
        queryFn: async (): Promise<AdminRegistry> => {
            const res = await fetch('/api/settings/rbac/registry');
            return readJson<AdminRegistry>(res, 'Failed to load the permission registry.');
        },
    });
}

function useRegistryMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.rbac.all });
            qc.invalidateQueries({ queryKey: queryKeys.ability.all });
            qc.invalidateQueries({ queryKey: ['settings', 'roles'] });
        },
    });
}

async function send<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, fallback: string): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return readJson<T>(res, fallback);
}

export function useCreatePermission() {
    return useRegistryMutation((input: PermissionInput) =>
        send<{ id: string }>('/api/settings/rbac/permissions', 'POST', input, 'Failed to create the permission.')
    );
}

export function useUpdatePermission() {
    return useRegistryMutation(({ id, ...input }: PermissionInput & { id: string; reason?: string }) =>
        send<unknown>(`/api/settings/rbac/permissions/${id}`, 'PUT', input, 'Failed to update the permission.')
    );
}

export function useDeletePermission() {
    return useRegistryMutation(({ id, reason }: { id: string; reason?: string }) =>
        send<unknown>(`/api/settings/rbac/permissions/${id}`, 'DELETE', { reason }, 'Failed to delete the permission.')
    );
}

export function useCreateModule() {
    return useRegistryMutation((input: ModuleFormInput) =>
        send<ModuleWriteResult>('/api/settings/rbac/modules', 'POST', input, 'Failed to create the module.')
    );
}

export function useUpdateModule() {
    return useRegistryMutation(({ id, ...input }: ModuleFormInput & { id: string }) =>
        send<ModuleWriteResult>(`/api/settings/rbac/modules/${id}`, 'PUT', input, 'Failed to update the module.')
    );
}

export function useDeleteModule() {
    return useRegistryMutation(({ id, reason }: { id: string; reason?: string }) =>
        send<unknown>(`/api/settings/rbac/modules/${id}`, 'DELETE', { reason }, 'Failed to delete the module.')
    );
}
