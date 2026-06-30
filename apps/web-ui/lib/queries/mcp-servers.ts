'use client';

/**
 * TanStack Query hooks for MCP server configuration.
 * Parameterized by `apiPath` so both surfaces reuse them:
 *   - '/api/mcp-servers'              (main AI Ops)
 *   - '/api/agent-ops/mcp-settings'   (Agent Ops)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { MCPConfigJson, MCPServerConfig, MCPServerJsonEntry } from '@/lib/agent/mcp-config';

export interface McpConfigResponse {
    servers: MCPServerConfig[];
    config: MCPConfigJson;
    isCustom: boolean;
}

export interface McpTestResult {
    success: boolean;
    toolCount?: number;
    tools?: string[];
    error?: string;
}

export function useMcpConfig(apiPath: string) {
    return useQuery({
        queryKey: queryKeys.mcpServers.config(apiPath),
        queryFn: async (): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath);
            if (!res.ok) throw new Error('Failed to load MCP configuration');
            return res.json();
        },
    });
}

export function useSaveMcpConfig(apiPath: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (config: MCPConfigJson): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Failed to save MCP configuration');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.mcpServers.config(apiPath) }),
    });
}

export function useResetMcpConfig(apiPath: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<McpConfigResponse> => {
            const res = await fetch(apiPath, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Failed to reset MCP configuration');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.mcpServers.config(apiPath) }),
    });
}

export function useTestMcpServer(apiPath: string) {
    return useMutation({
        mutationFn: async (vars: { id: string; entry: MCPServerJsonEntry }): Promise<McpTestResult> => {
            const res = await fetch(`${apiPath}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(vars),
            });
            return res.json();
        },
    });
}
