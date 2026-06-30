import { z } from 'zod';
import type { MCPConfigJson, MCPServerJsonEntry } from './mcp-config';
import { isRemoteEntry, DEFAULT_MCP_SERVERS } from './mcp-config';

const kvPairSchema = z.object({ key: z.string(), value: z.string() });

export const stdioRowSchema = z.object({
    id: z.string().min(1, 'Server ID is required'),
    type: z.literal('stdio'),
    command: z.string().min(1, 'Command is required'),
    args: z.array(z.string()),
    env: z.array(kvPairSchema),
    requiresAwsCredentials: z.boolean(),
    disabled: z.boolean(),
});

export const remoteRowSchema = z.object({
    id: z.string().min(1, 'Server ID is required'),
    type: z.enum(['sse', 'http']),
    url: z.string().url('Must be a valid http(s) URL'),
    headers: z.array(kvPairSchema),
    disabled: z.boolean(),
});

export const mcpRowSchema = z.discriminatedUnion('type', [stdioRowSchema, remoteRowSchema]);
export const mcpFormSchema = z.object({ servers: z.array(mcpRowSchema) });

export type McpStdioRow = z.infer<typeof stdioRowSchema>;
export type McpRemoteRow = z.infer<typeof remoteRowSchema>;
export type McpFormRow = z.infer<typeof mcpRowSchema>;
export type McpFormValues = z.infer<typeof mcpFormSchema>;

function recordToPairs(rec?: Record<string, string>): { key: string; value: string }[] {
    return Object.entries(rec || {}).map(([key, value]) => ({ key, value }));
}

function pairsToRecord(pairs: { key: string; value: string }[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { key, value } of pairs) {
        const k = key.trim();
        if (k) out[k] = value;
    }
    return out;
}

export function configToFormRows(config: MCPConfigJson): McpFormRow[] {
    return Object.entries(config.mcpServers).map(([id, entry]) => {
        if (isRemoteEntry(entry)) {
            return {
                id,
                type: entry.type,
                url: entry.url,
                headers: recordToPairs(entry.headers),
                disabled: entry.disabled === true,
            };
        }
        // Apply same default-server fallback as the runtime toServerConfig so that
        // the "Inject AWS credentials" toggle reflects the true runtime state even
        // when defaultsToJson() omitted the flag (e.g. aws-cost-explorer).
        const requiresAwsCredentials =
            entry.requiresAwsCredentials ??
            DEFAULT_MCP_SERVERS.find(s => s.id === id)?.requiresAwsCredentials ??
            false;
        return {
            id,
            type: 'stdio',
            command: entry.command,
            args: [...entry.args],
            env: recordToPairs(entry.env),
            requiresAwsCredentials,
            disabled: entry.disabled === true,
        };
    });
}

export function formRowsToConfig(rows: McpFormRow[]): { config: MCPConfigJson; error?: string } {
    const mcpServers: Record<string, MCPServerJsonEntry> = {};
    for (const row of rows) {
        const id = row.id.trim();
        if (!id) return { config: { mcpServers }, error: 'Every server needs an ID' };
        if (mcpServers[id]) return { config: { mcpServers }, error: `Duplicate server ID "${id}"` };

        if (row.type === 'sse' || row.type === 'http') {
            // McpRemoteRow — `type` is z.enum(['sse','http']) so TS narrows this arm correctly.
            const remoteRow = row as McpRemoteRow;
            const headers = pairsToRecord(remoteRow.headers);
            mcpServers[id] = {
                type: remoteRow.type,
                url: remoteRow.url,
                ...(Object.keys(headers).length ? { headers } : {}),
                disabled: remoteRow.disabled,
            };
        } else {
            // McpStdioRow — TS cannot narrow the else-branch of a union where the remote
            // arm uses z.enum (multi-literal) rather than two separate z.literal branches,
            // so we assert the narrowed type explicitly.
            const stdioRow = row as McpStdioRow;
            // Trim and drop blank/whitespace-only args at save time.
            // The textarea onChange keeps raw lines so typing is not disrupted (T7).
            const args = stdioRow.args.map((a: string) => a.trim()).filter(Boolean);
            const env = pairsToRecord(stdioRow.env);
            mcpServers[id] = {
                command: stdioRow.command,
                args,
                ...(Object.keys(env).length ? { env } : {}),
                ...(stdioRow.requiresAwsCredentials ? { requiresAwsCredentials: true } : {}),
                disabled: stdioRow.disabled,
            };
        }
    }
    return { config: { mcpServers } };
}
