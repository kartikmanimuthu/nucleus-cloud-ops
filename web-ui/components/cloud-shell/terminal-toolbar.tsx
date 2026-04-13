'use client';

import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Wifi, WifiOff, X, Clock } from 'lucide-react';
import type { ShellSession } from '@/lib/cloud-shell/types';

export interface TerminalToolbarProps {
    session: ShellSession | null;
    connected: boolean;
    accounts: { id: string; name: string; accountId: string }[];
    selectedAccountId: string | null;
    onAccountChange: (accountId: string) => void;
    onDisconnect: () => void;
}

function useSessionTimer(startedAt: string | null): string {
    const [elapsed, setElapsed] = useState('00:00');

    useEffect(() => {
        if (!startedAt) return;
        const tick = () => {
            const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
            const m = String(Math.floor(secs / 60)).padStart(2, '0');
            const s = String(secs % 60).padStart(2, '0');
            setElapsed(`${m}:${s}`);
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [startedAt]);

    return elapsed;
}

export function TerminalToolbar({
    session,
    connected,
    accounts,
    selectedAccountId,
    onAccountChange,
    onDisconnect,
}: TerminalToolbarProps) {
    const elapsed = useSessionTimer(session?.startedAt ?? null);

    return (
        <div className="flex items-center gap-3 px-3 py-2 bg-[#1a1b26] border-b border-[#414868] text-sm">
            {/* Connection status */}
            <div className="flex items-center gap-1.5">
                {connected ? (
                    <Wifi className="h-4 w-4 text-green-400" />
                ) : (
                    <WifiOff className="h-4 w-4 text-red-400" />
                )}
                <Badge
                    variant="outline"
                    className={connected ? 'border-green-500 text-green-400' : 'border-red-500 text-red-400'}
                >
                    {connected ? 'Connected' : 'Disconnected'}
                </Badge>
            </div>

            <div className="h-4 w-px bg-[#414868]" />

            {/* Account selector */}
            <Select
                value={selectedAccountId ?? ''}
                onValueChange={onAccountChange}
                disabled={!connected}
            >
                <SelectTrigger className="h-7 w-52 bg-[#24283b] border-[#414868] text-[#c0caf5] text-xs">
                    <SelectValue placeholder="Select account…" />
                </SelectTrigger>
                <SelectContent className="bg-[#24283b] border-[#414868]">
                    {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id} className="text-[#c0caf5] text-xs">
                            {a.name} ({a.accountId})
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* Region badge */}
            {session?.region && (
                <Badge variant="outline" className="border-[#414868] text-[#7aa2f7] text-xs">
                    {session.region}
                </Badge>
            )}

            <div className="flex-1" />

            {/* Session timer */}
            {session && (
                <div className="flex items-center gap-1 text-[#a9b1d6] text-xs">
                    <Clock className="h-3.5 w-3.5" />
                    <span>{elapsed}</span>
                </div>
            )}

            {/* Disconnect */}
            <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[#f7768e] hover:bg-[#24283b] hover:text-[#f7768e]"
                onClick={onDisconnect}
                disabled={!connected}
                data-testid="disconnect-button"
            >
                <X className="h-4 w-4 mr-1" />
                Disconnect
            </Button>
        </div>
    );
}
