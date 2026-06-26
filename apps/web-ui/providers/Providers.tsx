'use client';

import { SessionProvider } from 'next-auth/react';
import { TenantProvider } from '@/lib/tenant-context';
import { QueryProvider } from '@/providers/query-provider';

interface ProvidersProps {
    children: React.ReactNode;
}

export default function Providers({ children }: ProvidersProps) {
    return (
        <SessionProvider>
            <QueryProvider>
                <TenantProvider>
                    {children}
                </TenantProvider>
            </QueryProvider>
        </SessionProvider>
    );
}
