'use client';

import { SessionProvider } from 'next-auth/react';
import { TenantProvider } from '@/lib/tenant-context';

interface ProvidersProps {
    children: React.ReactNode;
}

export default function Providers({ children }: ProvidersProps) {
    return (
        <SessionProvider>
            <TenantProvider>
                {children}
            </TenantProvider>
        </SessionProvider>
    );
}
