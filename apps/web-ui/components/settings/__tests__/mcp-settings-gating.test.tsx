// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * The MCP editor gates on McpServer, on BOTH of its mounts.
 *
 * This one component backs two endpoints:
 *   /app/agent-ops/mcp-settings  -> /api/agent-ops/mcp-settings
 *   /app/channels/mcp-settings   -> /api/agent-ops/mcp-settings
 *   (the main AI Ops mount)      -> /api/mcp-servers
 *
 * It used to pick its subject from the apiPath, because the two routes guarded
 * themselves differently — 'AIOps' and 'Settings'. Both were module-wide
 * catch-alls the role editor hides, so neither mount was grantable from the
 * matrix, while a real 'McpServer' subject sat in the registry governing
 * nothing.
 *
 * The mount-independence is the property under test: a per-apiPath regression
 * would gate one page and not the other, which is exactly the bug this replaced
 * and exactly what a single-mount test would miss.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

beforeAll(() => {
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

/** Records every (action, subject) the component asks about. */
const asked: Array<{ action: string; subject: string }> = [];
let allowed = true;

vi.mock('@/hooks/use-can', () => ({
    useCan: (action: string, subject: string) => {
        asked.push({ action, subject });
        return allowed;
    },
    useDenialReason: (action: string, subject: string) =>
        allowed ? null : `Requires ${action} on ${subject}`,
}));

const CONFIG = { mcpServers: {} };

vi.mock('@/lib/queries/mcp-servers', () => ({
    useMcpConfig: () => ({ data: CONFIG, isLoading: false }),
    useSaveMcpConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useResetMcpConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // Backs the per-server "Test" button. Unused by these assertions, but the
    // module mock must be complete or the import fails outright.
    useTestMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The JSON mode embeds Monaco, which does not run in jsdom. The gated controls
// under test live outside it.
vi.mock('@monaco-editor/react', () => ({ default: () => null, Editor: () => null }));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

import { MCPSettings } from '../mcp-settings';

const saveButton = () => screen.getByRole('button', { name: /^Save$/i }) as HTMLButtonElement;

/** Both mounts, so a per-apiPath regression cannot hide behind one of them. */
const MOUNTS = ['/api/agent-ops/mcp-settings', '/api/mcp-servers'] as const;

describe('MCPSettings gates on McpServer regardless of which endpoint backs it', () => {
    it.each(MOUNTS)('asks for update/McpServer when mounted on %s', (apiPath) => {
        asked.length = 0;
        allowed = true;
        render(<MCPSettings apiPath={apiPath} />);

        // The subject must not vary with the endpoint. Neither module-wide
        // catch-all may be consulted — both are hidden from the role matrix, so
        // asking about them is the regression.
        expect(asked.some((q) => q.action === 'update' && q.subject === 'McpServer')).toBe(true);
        expect(asked.some((q) => q.subject === 'AIOps' || q.subject === 'Settings')).toBe(false);
    });

    it.each(MOUNTS)('disables Save with the reason when denied on %s', (apiPath) => {
        asked.length = 0;
        allowed = false;
        render(<MCPSettings apiPath={apiPath} />);

        const button = saveButton();
        expect(button.disabled).toBe(true);
        expect(button.parentElement?.getAttribute('title')).toBe('Requires update on McpServer');
    });

    it('leaves Save usable when granted', () => {
        asked.length = 0;
        allowed = true;
        render(<MCPSettings apiPath="/api/agent-ops/mcp-settings" />);

        expect(saveButton().disabled).toBe(false);
    });
});
