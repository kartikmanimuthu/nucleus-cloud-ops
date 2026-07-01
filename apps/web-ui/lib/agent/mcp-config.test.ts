import { describe, it, expect } from 'vitest';
import {
    jsonToServerConfigs,
    mergeConfigs,
    validateMcpConfig,
    type MCPConfigJson,
} from './mcp-config';

describe('jsonToServerConfigs — transports', () => {
    it('treats an entry with no "type" as stdio (backward compat)', () => {
        const json: MCPConfigJson = { mcpServers: { legacy: { command: 'uvx', args: ['x@latest'] } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport ?? 'stdio').toBe('stdio');
        expect(s.command).toBe('uvx');
        expect(s.args).toEqual(['x@latest']);
        expect(s.enabled).toBe(true);
    });

    it('maps an sse entry to a remote server config', () => {
        const json: MCPConfigJson = { mcpServers: { remote: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer t' } } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport).toBe('sse');
        expect(s.url).toBe('https://h/sse');
        expect(s.headers).toEqual({ Authorization: 'Bearer t' });
        expect(s.command).toBe('');
    });

    it('maps an http entry to a remote server config', () => {
        const json: MCPConfigJson = { mcpServers: { remote: { type: 'http', url: 'https://h/mcp' } } };
        const [s] = jsonToServerConfigs(json);
        expect(s.transport).toBe('http');
        expect(s.url).toBe('https://h/mcp');
    });
});

describe('mergeConfigs — user overrides win, defaults preserved', () => {
    it('overlays a remote user entry on top of defaults', () => {
        const merged = mergeConfigs({ mcpServers: { remote: { type: 'sse', url: 'https://h/sse' } } });
        const remote = merged.find(s => s.id === 'remote');
        expect(remote?.transport).toBe('sse');
        // a default still present
        expect(merged.find(s => s.id === 'aws-documentation')).toBeTruthy();
    });
});

describe('validateMcpConfig', () => {
    it('accepts a valid stdio entry', () => {
        expect(validateMcpConfig({ mcpServers: { a: { command: 'npx', args: ['-y', 'pkg'] } } })).toEqual({ ok: true });
    });
    it('accepts a valid sse entry', () => {
        expect(validateMcpConfig({ mcpServers: { a: { type: 'sse', url: 'https://h/sse' } } })).toEqual({ ok: true });
    });
    it('rejects a missing mcpServers object', () => {
        expect(validateMcpConfig({}).ok).toBe(false);
    });
    it('rejects a stdio entry missing command', () => {
        const r = validateMcpConfig({ mcpServers: { a: { args: [] } } });
        expect(r.ok).toBe(false);
    });
    it('rejects a remote entry with a bad url', () => {
        const r = validateMcpConfig({ mcpServers: { a: { type: 'http', url: 'not a url' } } });
        expect(r.ok).toBe(false);
    });
    it('rejects an unknown transport type', () => {
        const r = validateMcpConfig({ mcpServers: { a: { type: 'ws', url: 'https://h' } } } as any);
        expect(r.ok).toBe(false);
    });
});
