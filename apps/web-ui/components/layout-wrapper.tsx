'use client';

import { usePathname } from 'next/navigation';
import { AuthGuard } from './auth-guard';
import { PageTransition } from './page-transition';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './layout/app-sidebar';
import { Header } from './layout/header';

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    const isAppRoute = pathname.startsWith('/app');

    if (!isAppRoute) {
        return <>{children}</>;
    }

    return (
        <AuthGuard>
            <SidebarProvider>
                <AppSidebar />
                <SidebarInset className="min-w-0 overflow-hidden">
                    <Header />
                    <div className="min-w-0 flex-1 overflow-y-auto p-4">
                        <PageTransition>{children}</PageTransition>
                    </div>
                </SidebarInset>
            </SidebarProvider>
        </AuthGuard>
    );
}
