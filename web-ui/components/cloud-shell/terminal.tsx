'use client';

import { useEffect, useRef } from 'react';
import type { ShellClient } from '@/lib/cloud-shell/shell-client';

export interface TerminalProps {
    client: ShellClient | null;
    className?: string;
}

export function Terminal({ client, className }: TerminalProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
    const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
    const clientRef = useRef<ShellClient | null>(null);

    // Keep clientRef in sync so the onData handler always sees the latest client
    useEffect(() => {
        clientRef.current = client;
    }, [client]);

    useEffect(() => {
        if (!containerRef.current) return;

        let term: import('@xterm/xterm').Terminal;
        let fitAddon: import('@xterm/addon-fit').FitAddon;
        let resizeObserver: ResizeObserver;

        async function init() {
            const { Terminal: XTerm } = await import('@xterm/xterm');
            const { FitAddon } = await import('@xterm/addon-fit');
            const { WebLinksAddon } = await import('@xterm/addon-web-links');

            term = new XTerm({
                theme: {
                    background: '#1a1b26',
                    foreground: '#c0caf5',
                    cursor: '#c0caf5',
                    cursorAccent: '#1a1b26',
                    black: '#15161e',
                    red: '#f7768e',
                    green: '#9ece6a',
                    yellow: '#e0af68',
                    blue: '#7aa2f7',
                    magenta: '#bb9af7',
                    cyan: '#7dcfff',
                    white: '#a9b1d6',
                    brightBlack: '#414868',
                    brightRed: '#f7768e',
                    brightGreen: '#9ece6a',
                    brightYellow: '#e0af68',
                    brightBlue: '#7aa2f7',
                    brightMagenta: '#bb9af7',
                    brightCyan: '#7dcfff',
                    brightWhite: '#c0caf5',
                },
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
                fontSize: 14,
                lineHeight: 1.2,
                cursorBlink: true,
                scrollback: 5000,
                allowProposedApi: true,
            });

            fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.loadAddon(new WebLinksAddon());

            term.open(containerRef.current!);
            fitAddon.fit();

            termRef.current = term;
            fitRef.current = fitAddon;

            // Forward keyboard input to shell — uses ref so it always sees current client
            term.onData((data) => {
                clientRef.current?.sendInput(data);
            });

            // Resize observer — refit and notify server
            resizeObserver = new ResizeObserver(() => {
                fitAddon.fit();
                clientRef.current?.sendResize(term.cols, term.rows);
            });
            resizeObserver.observe(containerRef.current!);
        }

        init();

        return () => {
            resizeObserver?.disconnect();
            termRef.current?.dispose();
            termRef.current = null;
            fitRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wire up client output to terminal
    useEffect(() => {
        if (!client || !termRef.current) return;

        const term = termRef.current;
        // Replace the client's onOutput to write to the terminal
        const origOnOutput = client['onOutput'].bind(client);
        (client as any).onOutput = (data: string) => {
            term.write(data);
            origOnOutput(data);
        };
    }, [client]);

    return (
        <div
            ref={containerRef}
            className={className}
            style={{ width: '100%', height: '100%', overflow: 'hidden' }}
            data-testid="terminal-container"
        />
    );
}
