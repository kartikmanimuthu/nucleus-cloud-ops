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

    // Auto-start session on mount (no account = hub account)
    useEffect(() => {
        startSession();
        return () => {
            clientRef.current?.dispose();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
