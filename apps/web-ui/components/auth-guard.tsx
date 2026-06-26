'use client';

import { useSession } from 'next-auth/react';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect } from 'react';

interface AuthGuardProps {
    children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
    const { data: session, status } = useSession();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        // Skip auth check for login page
        if (pathname === '/login') {
            return;
        }

        // If loading, don't do anything yet
        if (status === 'loading') {
            return;
        }

        // If not authenticated and not on login page, redirect to login
        if (status === 'unauthenticated' || !session) {
            console.log('User not authenticated, redirecting to login');
            router.push('/login');
            return;
        }
    }, [session, status, router, pathname]);

    // Show loading spinner while checking authentication
    if (status === 'loading') {
        return (
            <div className="flex items-center justify-center h-screen">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            </div>
        );
    }

    // If on login page, show children regardless of auth status
    if (pathname === '/login') {
        return <>{children}</>;
    }

    // If not authenticated, show loading (will redirect in useEffect)
    if (status === 'unauthenticated' || !session) {
        return (
            <div className="flex items-center justify-center h-screen">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            </div>
        );
    }

    // If authenticated, show the protected content
    return <>{children}</>;
}
