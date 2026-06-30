import { describe, it, expect } from 'vitest';
import { configToFormRows, formRowsToConfig, mcpFormSchema, type McpFormRow } from './mcp-form-schema';
import type { MCPConfigJson } from './mcp-config';

describe('configToFormRows / formRowsToConfig round-trip', () => {
    it('round-trips a stdio entry with env', () => {
        const config: MCPConfigJson = { mcpServers: { a: { command: 'uvx', args: ['x'], env: { K: 'v' }, disabled: false, requiresAwsCredentials: true } } };
        const rows = configToFormRows(config);
        expect(rows[0]).toMatchObject({ id: 'a', type: 'stdio', command: 'uvx', args: ['x'], requiresAwsCredentials: true });
        expect(rows[0].type === 'stdio' && rows[0].env).toEqual([{ key: 'K', value: 'v' }]);
        const { config: out, error } = formRowsToConfig(rows);
        expect(error).toBeUndefined();
        expect(out.mcpServers.a).toMatchObject({ command: 'uvx', args: ['x'], env: { K: 'v' }, requiresAwsCredentials: true });
    });

    it('round-trips an sse entry with headers', () => {
        const config: MCPConfigJson = { mcpServers: { r: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' } } } };
        const rows = configToFormRows(config);
        const { config: out } = formRowsToConfig(rows);
        expect(out.mcpServers.r).toEqual({ type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' }, disabled: false });
    });

    it('flags duplicate ids', () => {
        const rows: McpFormRow[] = [
            { id: 'dup', type: 'stdio', command: 'a', args: [], env: [], requiresAwsCredentials: false, disabled: false },
            { id: 'dup', type: 'stdio', command: 'b', args: [], env: [], requiresAwsCredentials: false, disabled: false },
        ];
        expect(formRowsToConfig(rows).error).toMatch(/Duplicate/);
    });

    it('flags a blank id', () => {
        const rows: McpFormRow[] = [{ id: '   ', type: 'stdio', command: 'a', args: [], env: [], requiresAwsCredentials: false, disabled: false }];
        expect(formRowsToConfig(rows).error).toMatch(/ID/);
    });

    it('mcpFormSchema rejects a remote row with an invalid url', () => {
        const parsed = mcpFormSchema.safeParse({ servers: [{ id: 'r', type: 'http', url: 'nope', headers: [], disabled: false }] });
        expect(parsed.success).toBe(false);
    });
});
