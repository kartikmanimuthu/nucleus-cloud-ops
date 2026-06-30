import { z } from 'zod';
import type { MCPConfigJson, MCPServerJsonEntry } from './mcp-config';

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
        if (entry.type === 'sse' || entry.type === 'http') {
            return {
                id,
                type: entry.type,
                url: entry.url,
                headers: recordToPairs(entry.headers),
                disabled: entry.disabled === true,
            };
        }
        return {
            id,
            type: 'stdio',
            command: entry.command,
            args: [...entry.args],
            env: recordToPairs(entry.env),
            requiresAwsCredentials: entry.requiresAwsCredentials === true,
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
            const headers = pairsToRecord(row.headers);
            mcpServers[id] = {
                type: row.type,
                url: row.url,
                ...(Object.keys(headers).length ? { headers } : {}),
                disabled: row.disabled,
            };
        } else {
            const env = pairsToRecord(row.env);
            mcpServers[id] = {
                command: row.command,
                args: row.args,
                ...(Object.keys(env).length ? { env } : {}),
                ...(row.requiresAwsCredentials ? { requiresAwsCredentials: true } : {}),
                disabled: row.disabled,
            };
        }
    }
    return { config: { mcpServers } };
}
