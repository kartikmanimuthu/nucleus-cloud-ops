'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Terminal } from './terminal';
import { TerminalToolbar } from './terminal-toolbar';
import { ShellClient } from '@/lib/cloud-shell/shell-client';
import type { ShellSession } from '@/lib/cloud-shell/types';

interface AccountOption {
    id: string;
    name: string;
    accountId: string;
}

export function CloudShellPage() {
    const [session, setSession] = useState<ShellSession | null>(null);
    const [connected, setConnected] = useState(false);
    const [accounts, setAccounts] = useState<AccountOption[]>([]);
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const clientRef = useRef<ShellClient | null>(null);
    const startingRef = useRef(false);

    // Fetch available accounts on mount
    useEffect(() => {
        fetch('/api/accounts')
            .then((r) => r.json())
            .then((body) => {
                if (body.success && Array.isArray(body.data)) {
                    setAccounts(
                        body.data.map((a: { id: string; name: string; accountId: string }) => ({
                            id: a.id,
                            name: a.name,
                            accountId: a.accountId,
                        }))
                    );
                }
            })
            .catch(() => {/* non-fatal */});
    }, []);

    const startSession = useCallback(async (accountId?: string) => {
        if (startingRef.current) return;
        startingRef.current = true;
        setError(null);
        try {
            // 1. Create session record
            const createRes = await fetch('/api/shell/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId }),
            });
            const createBody = await createRes.json();
            if (!createBody.success) throw new Error(createBody.error ?? 'Failed to create session');
            const newSession: ShellSession = createBody.data;
            setSession(newSession);

            // 2. Get WebSocket URL
            const connectRes = await fetch('/api/shell/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: newSession.id, accountId, region: newSession.region }),
            });
            const connectBody = await connectRes.json();
            if (!connectBody.success) throw new Error(connectBody.error ?? 'Failed to connect');

            // 3. Open WebSocket
            const client = new ShellClient({
                wsUrl: connectBody.data.wsUrl,
                onOutput: () => {/* terminal.tsx handles this */},
                onExit: () => {
                    setConnected(false);
                    setSession((s) => s ? { ...s, status: 'terminated' } : null);
                },
                onError: (msg) => setError(msg),
                onOpen: () => setConnected(true),
                onClose: () => setConnected(false),
            });
            clientRef.current = client;
            client.connect();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            startingRef.current = false;
        }
    }, []);

    const handleDisconnect = useCallback(async () => {
        clientRef.current?.dispose();
        clientRef.current = null;
        setConnected(false);

        if (session) {
            await fetch(`/api/shell/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
            setSession(null);
        }
    }, [session]);

    const handleAccountChange = useCallback((accountId: string) => {
        setSelectedAccountId(accountId);
        if (!session) {
            startSession(accountId);
        }
    }, [session, startSession]);

    // Track session ID in a ref so cleanup handlers always see the latest value
    const sessionIdRef = useRef<string | null>(null);

    // Keep ref in sync with state
    useEffect(() => {
        sessionIdRef.current = session?.id ?? null;
    }, [session]);

    // Cleanup on unmount + tab close/navigate away
    useEffect(() => {
        const terminateCurrentSession = () => {
            const sid = sessionIdRef.current;
            if (sid) {
                // sendBeacon is reliable during page unload (fetch may be cancelled)
                navigator.sendBeacon(`/api/shell/sessions/${sid}?_method=DELETE`);
            }
        };

        window.addEventListener('beforeunload', terminateCurrentSession);

        return () => {
            window.removeEventListener('beforeunload', terminateCurrentSession);
            // Also terminate on React unmount (e.g. navigating to another page)
            const sid = sessionIdRef.current;
            if (sid) {
                fetch(`/api/shell/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
            }
            clientRef.current?.dispose();
        };
    }, []);

    // No session yet — show start screen
    if (!session) {
        return (
            <div className="flex flex-col h-full bg-[#1a1b26]" data-testid="cloud-shell-page">
                <div className="flex flex-1 items-center justify-center">
                    <div className="flex flex-col items-center gap-4 text-center max-w-md">
                        <div className="rounded-full bg-white/5 p-4">
                            <svg className="h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
                            </svg>
                        </div>
                        <h2 className="text-lg font-semibold text-gray-200">Cloud Shell</h2>
                        <p className="text-sm text-gray-400">
                            Open a terminal session to run AWS CLI commands against your connected accounts.
                        </p>

                        {accounts.length > 0 && (
                            <select
                                className="rounded-md border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-200"
                                value={selectedAccountId || ''}
                                onChange={(e) => setSelectedAccountId(e.target.value || null)}
                            >
                                <option value="">No account (local shell)</option>
                                {accounts.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.name} ({a.accountId})
                                    </option>
                                ))}
                            </select>
                        )}

                        <button
                            onClick={() => startSession(selectedAccountId || undefined)}
                            disabled={startingRef.current}
                            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                        >
                            {startingRef.current ? 'Starting...' : 'Open Terminal'}
                        </button>

                        {error && (
                            <p className="text-sm text-red-400">{error}</p>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1a1b26]" data-testid="cloud-shell-page">
            <TerminalToolbar
                session={session}
                connected={connected}
                accounts={accounts}
                selectedAccountId={selectedAccountId}
                onAccountChange={handleAccountChange}
                onDisconnect={handleDisconnect}
            />

            {error && (
                <div className="px-4 py-2 bg-red-900/30 border-b border-red-700 text-red-300 text-sm">
                    {error}
                </div>
            )}

            <div className="flex-1 min-h-0 p-2">
                <Terminal
                    client={clientRef.current}
                    className="h-full"
                />
            </div>
        </div>
    );
}
