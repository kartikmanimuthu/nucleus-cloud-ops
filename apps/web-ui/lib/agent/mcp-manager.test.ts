import { describe, it, expect, vi, beforeEach } from 'vitest';

const { StdioCtor, SseCtor, HttpCtor, ClientCtor, clientBehavior } = vi.hoisted(() => {
    const clientBehavior: { connect: () => Promise<void>; listTools: () => Promise<any> } = {
        connect: async () => {},
        listTools: async () => ({ tools: [] }),
    };
    const ClientCtor = vi.fn(function (this: any) {
        this.connect = (...a: any[]) => clientBehavior.connect.apply(null, a as []);
        this.listTools = (...a: any[]) => clientBehavior.listTools.apply(null, a as []);
        this.close = async () => {};
    });
    return {
        StdioCtor: vi.fn(function (this: any, opts: any) { this.kind = 'stdio'; this.opts = opts; }),
        SseCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'sse'; this.url = url; this.opts = opts; }),
        HttpCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'http'; this.url = url; this.opts = opts; }),
        ClientCtor,
        clientBehavior,
    };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientCtor }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioCtor }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: SseCtor }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: HttpCtor }));

import { buildTransport, MCPServerManager } from './mcp-manager';

describe('buildTransport', () => {
    it('builds a stdio transport for a stdio config', () => {
        const t: any = buildTransport({ id: 'a', name: 'A', description: '', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
        expect(t.kind).toBe('stdio');
        expect(t.opts.command).toBe('npx');
    });

    it('defaults to stdio when transport is absent', () => {
        const t: any = buildTransport({ id: 'a', name: 'A', description: '', enabled: true, command: 'uvx', args: [] });
        expect(t.kind).toBe('stdio');
    });

    it('builds an sse transport with headers', () => {
        const t: any = buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'sse', command: '', args: [], url: 'https://h/sse', headers: { Authorization: 'Bearer t' } });
        expect(t.kind).toBe('sse');
        expect(t.url.toString()).toBe('https://h/sse');
        expect(t.opts.requestInit.headers).toEqual({ Authorization: 'Bearer t' });
    });

    it('builds an http transport without headers (no requestInit)', () => {
        const t: any = buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'http', command: '', args: [], url: 'https://h/mcp' });
        expect(t.kind).toBe('http');
        expect(t.opts).toBeUndefined();
    });

    it('throws for a remote config missing a url', () => {
        expect(() => buildTransport({ id: 'r', name: 'R', description: '', enabled: true, transport: 'sse', command: '', args: [] }))
            .toThrow(/url/);
    });
});

describe('MCPServerManager.probeConnection (test-connection health probe)', () => {
    const httpConfig = {
        id: 'probe', name: 'Probe', description: '', enabled: true,
        transport: 'http' as const, command: '', args: [], url: 'https://h/mcp',
    };

    beforeEach(() => {
        clientBehavior.connect = async () => {};
        clientBehavior.listTools = async () => ({ tools: [] });
    });

    it('SUCCEEDS when the server advertises at least one tool', async () => {
        clientBehavior.listTools = async () => ({ tools: [{ name: 'do_thing' }, { name: 'other' }] });
        const mgr = new MCPServerManager();
        const result = await mgr.probeConnection(httpConfig);
        expect(result.toolCount).toBe(2);
        expect(result.tools).toEqual(['do_thing', 'other']);
    });

    it('FAILS (throws) when the server connects but exposes zero tools', async () => {
        clientBehavior.listTools = async () => ({ tools: [] });
        const mgr = new MCPServerManager();
        await expect(mgr.probeConnection(httpConfig)).rejects.toThrow(/no tools/i);
    });

    it('FAILS (throws) when tool discovery errors — must not be swallowed', async () => {
        clientBehavior.listTools = async () => { throw new Error('401 Unauthorized'); };
        const mgr = new MCPServerManager();
        await expect(mgr.probeConnection(httpConfig)).rejects.toThrow(/401|unauthorized/i);
    });
});
