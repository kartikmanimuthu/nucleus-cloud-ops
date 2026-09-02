import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit-service', () => ({ AuditService: { logResourceAction: vi.fn().mockResolvedValue(undefined) } }));

import { AuditService } from '@/lib/audit-service';
import { createMCPTools, getMCPToolsDescription } from './mcp-tools';
import type { MCPToolInfo } from './mcp-manager';

function fakeManager(tools: MCPToolInfo[], executeTool = vi.fn().mockResolvedValue({ content: 'ok' })) {
    return {
        getAllTools: () => tools,
        getToolsForServers: (ids: string[]) => tools.filter(t => ids.includes(t.mcpServerId)),
        executeTool,
    } as any;
}

const baseTool = (overrides: Partial<MCPToolInfo> = {}): MCPToolInfo => ({
    mcpServerId: 'tenant-1##grafana',
    mcpServerName: 'Grafana',
    name: 'query_metrics',
    description: 'Query metrics',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    ...overrides,
});

describe('createMCPTools', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns an empty array when there are no MCP tools', () => {
        expect(createMCPTools(fakeManager([]))).toEqual([]);
    });

    it('derives a namespaced tool name stripping the tenant prefix', () => {
        const [t] = createMCPTools(fakeManager([baseTool()]));
        expect(t.name).toBe('mcp_grafana_query_metrics');
    });

    it('includes the last 4 digits of the account id for an account-scoped server and truncates to 64 chars', () => {
        const [t] = createMCPTools(fakeManager([baseTool({
            mcpServerId: 'tenant-1##aws-reader::123456789012',
            name: 'a_very_long_tool_name_that_pushes_the_namespaced_identifier_past_the_bedrock_limit',
        })]));
        expect(t.name).toContain('mcp_aws-reader_9012_');
        expect(t.name.length).toBeLessThanOrEqual(64);
    });

    it('prefixes the description with the server name, and with the account id when scoped', () => {
        const [plain] = createMCPTools(fakeManager([baseTool()]));
        expect(plain.description).toBe('[MCP: Grafana] Query metrics');

        const [scoped] = createMCPTools(fakeManager([baseTool({
            mcpServerId: 'tenant-1##aws-reader::123456789012',
        })]));
        expect(scoped.description).toContain('Account: 123456789012');
    });

    it('falls back to the tool name in the description when no description is present', () => {
        const [t] = createMCPTools(fakeManager([baseTool({ description: undefined })]));
        expect(t.description).toBe('[MCP: Grafana] query_metrics');
    });

    it('converts a JSON-schema object with mixed property types to a working zod schema', async () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'a name' },
                mode: { type: 'string', enum: ['a', 'b'] },
                count: { type: 'number' },
                flag: { type: 'boolean' },
                tags: { type: 'array', items: { type: 'string' } },
                anyArr: { type: 'array' },
                nested: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
                freeform: { type: 'object' },
                mystery: {},
            },
            required: ['name'],
        };
        const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })]));
        const parsed = (t as any).schema.parse({
            name: 'x', mode: 'a', count: 1, flag: true, tags: ['a'], anyArr: [1, 2],
            nested: { x: 'y' }, freeform: { any: 'thing' }, mystery: 'whatever',
        });
        expect(parsed.name).toBe('x');
        // "name" is required, everything else is optional
        expect(() => (t as any).schema.parse({ name: 'x' })).not.toThrow();
        expect(() => (t as any).schema.parse({})).toThrow();
        void parsed;
    });

    it('falls back to a permissive passthrough schema when schema conversion throws', () => {
        const bogusSchema = {
            type: 'object',
            get properties() { throw new Error('schema explosion'); },
        };
        const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: bogusSchema as any })]));
        // Passthrough — arbitrary extra keys are accepted without validation error.
        expect(() => (t as any).schema.parse({ anything: 'goes', here: 1 })).not.toThrow();
    });

    it('executes the tool, formats a text-array result, and logs a success audit event', async () => {
        const executeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] });
        const [t] = createMCPTools(fakeManager([baseTool()], executeTool));

        const result = await t.invoke({ query: 'x' }, { configurable: { tenant_id: 'tenant-1', user_id: 'user-1' } });

        expect(result).toBe('hello\n\nworld');
        expect(executeTool).toHaveBeenCalledWith('tenant-1##grafana', 'query_metrics', { query: 'x' });
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'success', user: 'user-1', tenantId: 'tenant-1' }),
        );
    });

    it('formats image and resource content items, and unknown item shapes via JSON.stringify', async () => {
        const executeTool = vi.fn().mockResolvedValue({
            content: [
                { type: 'image', mimeType: 'image/png' },
                { type: 'image' },
                { type: 'resource', uri: 's3://bucket/key' },
                { type: 'resource' },
                { type: 'other', value: 1 },
            ],
        });
        const [t] = createMCPTools(fakeManager([baseTool()], executeTool));
        const result = await t.invoke({ query: 'x' });
        expect(result).toContain('[Image: image/png]');
        expect(result).toContain('[Image: unknown]');
        expect(result).toContain('[Resource: s3://bucket/key]');
        expect(result).toContain('[Resource: unknown]');
        expect(result).toContain('{"type":"other","value":1}');
    });

    it('returns string content as-is and stringifies a non-string, non-array content object', async () => {
        const stringExec = vi.fn().mockResolvedValue({ content: 'plain text result' });
        const [t1] = createMCPTools(fakeManager([baseTool()], stringExec));
        expect(await t1.invoke({ query: 'x' })).toBe('plain text result');

        const objectExec = vi.fn().mockResolvedValue({ content: { some: 'object' } });
        const [t2] = createMCPTools(fakeManager([baseTool()], objectExec));
        expect(await t2.invoke({ query: 'x' })).toBe('{"some":"object"}');
    });

    it('reports "No result returned" when the result has no content', async () => {
        const executeTool = vi.fn().mockResolvedValue(null);
        const [t] = createMCPTools(fakeManager([baseTool()], executeTool));
        expect(await t.invoke({ query: 'x' })).toBe('No result returned from MCP tool.');
    });

    it('returns a formatted error string and logs an error audit event when execution throws', async () => {
        const executeTool = vi.fn().mockRejectedValue(new Error('MCP server unreachable'));
        const [t] = createMCPTools(fakeManager([baseTool()], executeTool));
        const result = await t.invoke({ query: 'x' });
        expect(result).toContain('Error executing MCP tool "query_metrics": MCP server unreachable');
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('does not block or fail tool execution when the audit write itself rejects', async () => {
        vi.mocked(AuditService.logResourceAction).mockRejectedValue(new Error('audit db down'));
        const [t] = createMCPTools(fakeManager([baseTool()]));
        await expect(t.invoke({ query: 'x' })).resolves.toBe('ok');
    });

    it('attributes the audit event to "agent"/"system" when no user_id is present in config', async () => {
        const [t] = createMCPTools(fakeManager([baseTool()]));
        await t.invoke({ query: 'x' });
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ user: 'agent', userType: 'system' }),
        );
    });

    it('includes the accountId in the audit event for an account-scoped tool call', async () => {
        const [t] = createMCPTools(fakeManager([baseTool({ mcpServerId: 'tenant-1##aws-reader::123456789012' })]));
        await t.invoke({ query: 'x' });
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: '123456789012' }),
        );
    });

    describe('coerceInputToSchema (exercised through direct func() calls — invoke() would reject mismatched types at the zod boundary before this logic ever runs)', () => {
        const schema = {
            type: 'object',
            properties: {
                str: { type: 'string' },
                num: { type: 'number' },
                bool: { type: 'boolean' },
                arr: { type: 'array' },
                obj: { type: 'object' },
            },
        };

        it('coerces a single-element array to its bare string value', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ str: ['UnblendedCost'] });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { str: 'UnblendedCost' });
        });

        it('coerces a multi-element array to a JSON string', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ str: ['a', 'b'] });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { str: '["a","b"]' });
        });

        it('coerces an object to a JSON string, and numbers/booleans to strings, when a string is expected', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ str: { Type: 'DIMENSION' } });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { str: '{"Type":"DIMENSION"}' });
        });

        it('coerces a numeric string to a number when a number is expected, leaving an unparsable one alone', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ num: '42' });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { num: 42 });

            executeTool.mockClear();
            await (t as any).func({ num: 'not-a-number' });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { num: 'not-a-number' });
        });

        it('coerces a "true"/"false" string to a boolean when a boolean is expected', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ bool: 'true' });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { bool: true });
        });

        it('parses a JSON array/object string when an array/object is expected, leaving invalid JSON alone', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await (t as any).func({ arr: '[1,2,3]', obj: '{"a":1}' });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { arr: [1, 2, 3], obj: { a: 1 } });

            executeTool.mockClear();
            await (t as any).func({ arr: 'not json', obj: 'also not json' });
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { arr: 'not json', obj: 'also not json' });
        });

        it('leaves an already-correct value untouched', async () => {
            const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
            const [t] = createMCPTools(fakeManager([baseTool({ inputSchema: schema })], executeTool));
            await t.invoke({ str: 'already a string', num: 5, bool: false } as any);
            expect(executeTool).toHaveBeenCalledWith(expect.anything(), expect.anything(), { str: 'already a string', num: 5, bool: false });
        });
    });
});

describe('getMCPToolsDescription', () => {
    it('returns an empty string when there are no tools', () => {
        expect(getMCPToolsDescription(fakeManager([]))).toBe('');
    });

    it('groups tools by server name and strips the tenant prefix from the tool name', () => {
        const desc = getMCPToolsDescription(fakeManager([
            baseTool({ mcpServerId: 'tenant-1##grafana', name: 'query' }),
            baseTool({ mcpServerId: 'tenant-1##grafana', name: 'alerts' }),
            baseTool({ mcpServerId: 'tenant-1##other', mcpServerName: 'Other', name: 'do_thing' }),
        ]));
        expect(desc).toContain('[Grafana]:');
        expect(desc).toContain('mcp_grafana_query');
        expect(desc).toContain('mcp_grafana_alerts');
        expect(desc).toContain('[Other]:');
        expect(desc).toContain('mcp_other_do_thing');
    });

    it('truncates a long description to 100 chars and falls back to the tool name when absent', () => {
        const longDesc = 'x'.repeat(200);
        const desc = getMCPToolsDescription(fakeManager([
            baseTool({ description: longDesc }),
            baseTool({ name: 'unnamed_tool', description: undefined }),
        ]));
        expect(desc).toContain('x'.repeat(100));
        expect(desc).not.toContain('x'.repeat(101));
        expect(desc).toContain('unnamed_tool: unnamed_tool');
    });

    it('respects the serverIds filter, delegating to getToolsForServers', () => {
        const mgr = fakeManager([baseTool({ mcpServerId: 'tenant-1##a' }), baseTool({ mcpServerId: 'tenant-1##b', name: 'other' })]);
        const desc = getMCPToolsDescription(mgr, ['tenant-1##a']);
        expect(desc).toContain('mcp_a_query_metrics');
        expect(desc).not.toContain('mcp_b_other');
    });
});
