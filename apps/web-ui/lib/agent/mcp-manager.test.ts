import { describe, it, expect, vi } from 'vitest';

const { StdioCtor, SseCtor, HttpCtor } = vi.hoisted(() => ({
    StdioCtor: vi.fn(function (this: any, opts: any) { this.kind = 'stdio'; this.opts = opts; }),
    SseCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'sse'; this.url = url; this.opts = opts; }),
    HttpCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'http'; this.url = url; this.opts = opts; }),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioCtor }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: SseCtor }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: HttpCtor }));

import { buildTransport } from './mcp-manager';

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
