'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { AuthGuard } from './auth-guard';

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    const isAppRoute = pathname.startsWith('/app');

    if (!isAppRoute) {
        return <>{children}</>;
    }

    return (
        <AuthGuard>
            <div className="flex min-h-screen bg-background h-screen overflow-hidden">
                <Sidebar />
                <main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
                    <div className="p-2 min-w-0">{children}</div>
                </main>
            </div>
        </AuthGuard>
    );
}
