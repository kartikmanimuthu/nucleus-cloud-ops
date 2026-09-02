import { describe, it, expect } from 'vitest';
import {
    jsonToServerConfigs,
    mergeConfigs,
    validateMcpConfig,
    resolveEnabledServerIds,
    DEFAULT_MCP_SERVERS,
    isRemoteEntry,
    defaultsToJson,
    getMCPServerConfigById,
    getEnabledMCPServers,
    MCP_SECRET_MASK,
    maskServerConfigs,
    maskMcpConfigJson,
    restoreMaskedSecrets,
    type MCPConfigJson,
    type MCPServerConfig,
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
    it('returns the default baseline as-is when there is no saved config', () => {
        // DEFAULT_MCP_SERVERS ships empty by design (comment in mcp-config.ts:
        // "saved tenant configs are merged on top of this empty baseline") — users
        // add servers through the settings UI rather than getting built-ins.
        expect(mergeConfigs(null)).toBe(DEFAULT_MCP_SERVERS);
    });

    it('overlays a remote user entry on top of defaults', () => {
        const merged = mergeConfigs({ mcpServers: { remote: { type: 'sse', url: 'https://h/sse' } } });
        const remote = merged.find(s => s.id === 'remote');
        expect(remote?.transport).toBe('sse');
    });

    it('preserves every default id not overridden by the saved config', () => {
        // Defaults ship empty today, so this exercises the union logic (rather
        // than a specific default surviving) — every default id must appear
        // untouched in the merged result unless the user config redeclares it.
        const merged = mergeConfigs({ mcpServers: { remote: { type: 'sse', url: 'https://h/sse' } } });
        const defaultIds = DEFAULT_MCP_SERVERS.map(s => s.id);
        for (const id of defaultIds) {
            expect(merged.find(s => s.id === id)).toBeTruthy();
        }
        expect(merged).toHaveLength(defaultIds.length + 1);
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

describe('resolveEnabledServerIds', () => {
    const configs = [
        { id: 'a', name: 'A', description: '', command: 'x', args: [], enabled: true },
        { id: 'b', name: 'B', description: '', command: 'x', args: [], enabled: false },
        { id: 'c', name: 'C', description: '', command: 'x', args: [], enabled: true },
    ] as any;

    it('returns all enabled ids when none requested', () => {
        expect(resolveEnabledServerIds(undefined, configs)).toEqual(['a', 'c']);
        expect(resolveEnabledServerIds([], configs)).toEqual(['a', 'c']);
    });

    it('intersects requested ids with enabled configs', () => {
        expect(resolveEnabledServerIds(['a', 'b'], configs)).toEqual(['a']);
    });

    it('drops requested ids that are disabled or unknown', () => {
        expect(resolveEnabledServerIds(['b', 'ghost'], configs)).toEqual([]);
    });

    it('preserves requested order', () => {
        expect(resolveEnabledServerIds(['c', 'a'], configs)).toEqual(['c', 'a']);
    });
});

describe('isRemoteEntry', () => {
    it('is true for sse/http entries and false for stdio (including the type-absent default)', () => {
        expect(isRemoteEntry({ type: 'sse', url: 'https://h' })).toBe(true);
        expect(isRemoteEntry({ type: 'http', url: 'https://h' })).toBe(true);
        expect(isRemoteEntry({ command: 'npx', args: [] })).toBe(false);
    });
});

describe('defaultsToJson / getMCPServerConfigById / getEnabledMCPServers', () => {
    it('reflect the empty DEFAULT_MCP_SERVERS baseline', () => {
        expect(defaultsToJson()).toEqual({ mcpServers: {} });
        expect(getMCPServerConfigById('anything')).toBeUndefined();
        expect(getEnabledMCPServers()).toEqual([]);
    });
});

describe('validateMcpConfig — additional edge cases', () => {
    it('rejects a non-object config and a null mcpServers', () => {
        expect(validateMcpConfig(null).ok).toBe(false);
        expect(validateMcpConfig('a string').ok).toBe(false);
        expect(validateMcpConfig({ mcpServers: null }).ok).toBe(false);
    });

    it('rejects a server entry that is not an object', () => {
        expect(validateMcpConfig({ mcpServers: { a: 'not-an-object' } }).ok).toBe(false);
        expect(validateMcpConfig({ mcpServers: { a: null } }).ok).toBe(false);
    });

    it('rejects a stdio entry with a blank command or a non-array args', () => {
        expect(validateMcpConfig({ mcpServers: { a: { command: '   ', args: [] } } }).ok).toBe(false);
        expect(validateMcpConfig({ mcpServers: { a: { command: 'npx', args: 'not-an-array' } } }).ok).toBe(false);
    });

    it('rejects a non-string url and a non-http(s) protocol', () => {
        expect(validateMcpConfig({ mcpServers: { a: { type: 'sse', url: 123 } } }).ok).toBe(false);
        expect(validateMcpConfig({ mcpServers: { a: { type: 'sse', url: 'ftp://h/x' } } }).ok).toBe(false);
    });

    it('accepts an empty mcpServers map', () => {
        expect(validateMcpConfig({ mcpServers: {} })).toEqual({ ok: true });
    });
});

describe('secret masking', () => {
    const serverWithSecrets: MCPServerConfig = {
        id: 'grafana', name: 'Grafana', description: '', enabled: true,
        command: 'npx', args: [],
        env: { GRAFANA_TOKEN: 'tok-123', GRAFANA_URL: 'https://g.example.com' },
        headers: { Authorization: 'Bearer abc', 'X-Region': 'us-east-1' },
    };

    it('maskServerConfigs masks secret-looking env/header keys but leaves others untouched', () => {
        const [masked] = maskServerConfigs([serverWithSecrets]);
        expect(masked.env?.GRAFANA_TOKEN).toBe(MCP_SECRET_MASK);
        expect(masked.env?.GRAFANA_URL).toBe('https://g.example.com');
        expect(masked.headers?.Authorization).toBe(MCP_SECRET_MASK);
        expect(masked.headers?.['X-Region']).toBe('us-east-1');
    });

    it('maskServerConfigs passes through undefined env/headers unchanged', () => {
        const [masked] = maskServerConfigs([{ ...serverWithSecrets, env: undefined, headers: undefined }]);
        expect(masked.env).toBeUndefined();
        expect(masked.headers).toBeUndefined();
    });

    it('does not mask an empty secret value (nothing to hide)', () => {
        const [masked] = maskServerConfigs([{ ...serverWithSecrets, env: { GRAFANA_TOKEN: '' } }]);
        expect(masked.env?.GRAFANA_TOKEN).toBe('');
    });

    it('maskMcpConfigJson masks headers on remote entries and env on stdio entries', () => {
        const json: MCPConfigJson = {
            mcpServers: {
                remote: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'Bearer abc' } },
                local: { command: 'npx', args: [], env: { API_KEY: 'k1' } },
            },
        };
        const masked = maskMcpConfigJson(json);
        expect((masked.mcpServers.remote as any).headers.Authorization).toBe(MCP_SECRET_MASK);
        expect((masked.mcpServers.local as any).env.API_KEY).toBe(MCP_SECRET_MASK);
    });

    it('restoreMaskedSecrets restores an unchanged placeholder from the stored config', () => {
        const stored: MCPConfigJson = { mcpServers: { local: { command: 'npx', args: [], env: { API_KEY: 'real-secret' } } } };
        const incoming: MCPConfigJson = { mcpServers: { local: { command: 'npx', args: [], env: { API_KEY: MCP_SECRET_MASK, OTHER: 'plain' } } } };

        const restored = restoreMaskedSecrets(incoming, stored);
        expect((restored.mcpServers.local as any).env).toEqual({ API_KEY: 'real-secret', OTHER: 'plain' });
    });

    it('restoreMaskedSecrets drops the field entirely when there is no stored value to restore', () => {
        const incoming: MCPConfigJson = { mcpServers: { local: { command: 'npx', args: [], env: { API_KEY: MCP_SECRET_MASK } } } };
        const restored = restoreMaskedSecrets(incoming, null);
        expect((restored.mcpServers.local as any).env).toEqual({});
    });

    it('restoreMaskedSecrets restores headers for a remote entry, keyed against the stored remote entry', () => {
        const stored: MCPConfigJson = { mcpServers: { remote: { type: 'sse', url: 'https://h', headers: { Authorization: 'Bearer real' } } } };
        const incoming: MCPConfigJson = { mcpServers: { remote: { type: 'sse', url: 'https://h', headers: { Authorization: MCP_SECRET_MASK } } } };
        const restored = restoreMaskedSecrets(incoming, stored);
        expect((restored.mcpServers.remote as any).headers.Authorization).toBe('Bearer real');
    });

    it('restoreMaskedSecrets does not cross-restore from a stored entry of a different transport shape', () => {
        // Stored entry for this id is stdio (no headers); incoming is now remote — nothing to restore from.
        const stored: MCPConfigJson = { mcpServers: { x: { command: 'npx', args: [] } } };
        const incoming: MCPConfigJson = { mcpServers: { x: { type: 'sse', url: 'https://h', headers: { Authorization: MCP_SECRET_MASK } } } };
        const restored = restoreMaskedSecrets(incoming, stored);
        expect((restored.mcpServers.x as any).headers).toEqual({});
    });

    it('restoreMaskedSecrets passes through an entry with no env/headers unchanged', () => {
        const incoming: MCPConfigJson = { mcpServers: { remote: { type: 'http', url: 'https://h' } } };
        const restored = restoreMaskedSecrets(incoming, null);
        expect((restored.mcpServers.remote as any).headers).toBeUndefined();
    });
});
