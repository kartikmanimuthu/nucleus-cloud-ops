'use client';

/**
 * TanStack Query hooks for the user's organizations (org switcher).
 * The switch mutation only performs the API call; the caller is responsible
 * for refreshing the NextAuth session + router afterwards.
 */
import { useMutation, useQuery } from '@tanstack/react-query';

export interface Org {
    id: string;
    name: string;
    slug: string | null;
    role: string | null;
    logoUrl: string | null;
}

export function useMyOrgs() {
    return useQuery({
        queryKey: ['tenants', 'my-orgs'] as const,
        queryFn: async (): Promise<Org[]> => {
            const res = await fetch('/api/tenants/my-orgs');
            if (!res.ok) throw new Error('Failed to fetch orgs');
            const data = await res.json();
            return data.orgs ?? [];
        },
    });
}

export function useSwitchOrg() {
    return useMutation({
        mutationFn: async (tenantId: string) => {
            const res = await fetch('/api/tenants/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenantId }),
            });
            if (!res.ok) throw new Error('Failed to switch org');
            return res.json().catch(() => ({}));
        },
    });
}
