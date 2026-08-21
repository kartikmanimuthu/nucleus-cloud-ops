'use client';

import { SessionProvider } from 'next-auth/react';
import { TenantProvider } from '@/lib/tenant-context';
import { QueryProvider } from '@/providers/query-provider';
import { AbilityProvider } from '@/providers/ability-provider';

interface ProvidersProps {
    children: React.ReactNode;
}

export default function Providers({ children }: ProvidersProps) {
    return (
        <SessionProvider>
            <QueryProvider>
                <TenantProvider>
                    {/* Inside QueryProvider — the ability is fetched with useQuery.
                        Inside TenantProvider so an org switch remounts it and the
                        new tenant's rules are fetched rather than carried over. */}
                    <AbilityProvider>
                        {children}
                    </AbilityProvider>
                </TenantProvider>
            </QueryProvider>
        </SessionProvider>
    );
}
