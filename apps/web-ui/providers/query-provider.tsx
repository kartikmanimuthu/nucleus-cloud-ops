'use client';

import { useState } from 'react';
import {
    QueryClient,
    QueryClientProvider as TanStackQueryClientProvider,
} from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

/**
 * App-wide TanStack Query provider.
 *
 * The QueryClient is created lazily in component state so a fresh client is
 * minted per browser session (and never shared across requests on the server).
 * Defaults are tuned for an internal ops dashboard: data is considered fresh
 * for 30s, retried once, and not refetched on every window focus.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 30_000,
                        gcTime: 5 * 60_000,
                        retry: 1,
                        refetchOnWindowFocus: false,
                    },
                    mutations: {
                        retry: 0,
                    },
                },
            }),
    );

    return (
        <TanStackQueryClientProvider client={queryClient}>
            {children}
            {process.env.NODE_ENV === 'development' && (
                <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
            )}
        </TanStackQueryClientProvider>
    );
}
