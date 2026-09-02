import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

const { StdioCtor, SseCtor, HttpCtor, ClientCtor, clientBehavior } = vi.hoisted(() => {
    const clientBehavior: { connect: () => Promise<void>; listTools: () => Promise<any>; callTool: (...a: any[]) => Promise<any>; close: () => Promise<void> } = {
        connect: async () => {},
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ ok: true }),
        close: async () => {},
    };
    const ClientCtor = vi.fn(function (this: any) {
        this.connect = (...a: any[]) => clientBehavior.connect.apply(null, a as []);
        this.listTools = (...a: any[]) => clientBehavior.listTools.apply(null, a as []);
        this.callTool = (...a: any[]) => clientBehavior.callTool.apply(null, a as []);
        this.close = (...a: any[]) => clientBehavior.close.apply(null, a as []);
    });
    return {
        StdioCtor: vi.fn(function (this: any, opts: any) { this.kind = 'stdio'; this.opts = opts; this.close = async () => {}; }),
        SseCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'sse'; this.url = url; this.opts = opts; this.close = async () => {}; }),
        HttpCtor: vi.fn(function (this: any, url: any, opts: any) { this.kind = 'http'; this.url = url; this.opts = opts; this.close = async () => {}; }),
        ClientCtor,
        clientBehavior,
    };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientCtor }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioCtor }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: SseCtor }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: HttpCtor }));

vi.mock('./session-manager', () => ({
    createSessionProfile: vi.fn().mockResolvedValue({ profileName: 'nucleus-acc-1', credentialsFile: '/tmp/creds' }),
}));

import { buildTransport, MCPServerManager, isCommandAvailable, tenantScopedKey, getMCPManager } from './mcp-manager';
import { createSessionProfile } from './session-manager';

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
        clientBehavior.callTool = async () => ({ ok: true });
        clientBehavior.close = async () => {};
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

function mockAvailableCommands(available: string[]) {
    const accessSpy = vi.spyOn(fs, 'accessSync').mockImplementation((candidate: any) => {
        const base = String(candidate).split('/').pop();
        if (!available.includes(base!)) throw new Error('ENOENT');
    });
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((candidate: any) => {
        const base = String(candidate).split('/').pop();
        return { isFile: () => available.includes(base!) } as any;
    });
    return { accessSpy, statSpy };
}

describe('isCommandAvailable', () => {
    afterEach(() => vi.restoreAllMocks());

    it('is false for an empty command', () => {
        expect(isCommandAvailable('')).toBe(false);
    });

    it('checks an explicit path (containing "/") directly, ignoring searchPath', () => {
        mockAvailableCommands(['my-tool']);
        expect(isCommandAvailable('./bin/my-tool', '/usr/bin')).toBe(true);
    });

    it('is false when the explicit path is not executable', () => {
        mockAvailableCommands([]);
        expect(isCommandAvailable('./bin/missing-tool')).toBe(false);
    });

    it('finds a bare command by walking each PATH directory', () => {
        mockAvailableCommands(['npx']);
        expect(isCommandAvailable('npx', '/usr/bin:/usr/local/bin')).toBe(true);
    });

    it('is false when no PATH directory has the command', () => {
        mockAvailableCommands(['npx']);
        expect(isCommandAvailable('docker', '/usr/bin:/usr/local/bin')).toBe(false);
    });

    it('skips empty PATH segments without throwing', () => {
        mockAvailableCommands(['npx']);
        expect(isCommandAvailable('npx', '/usr/bin::/usr/local/bin:')).toBe(true);
    });
});

describe('MCPServerManager stdio connect — docker/uvx adaptation', () => {
    const dockerConfig = {
        id: 'grafana', name: 'Grafana', description: '', enabled: true,
        transport: 'stdio' as const, command: 'docker',
        args: ['run', '--rm', '-i', '-e', 'GRAFANA_URL', '-e', 'GRAFANA_TOKEN', 'grafana/mcp-grafana'],
    };

    beforeEach(() => {
        clientBehavior.connect = async () => {};
        clientBehavior.listTools = async () => ({ tools: [{ name: 't' }] });
        StdioCtor.mockClear();
    });
    afterEach(() => vi.restoreAllMocks());

    it('substitutes the native npx alternative when docker is unavailable and carries over matching env vars', async () => {
        mockAvailableCommands(['npx']);
        vi.stubEnv('GRAFANA_TOKEN', 'secret-token');
        try {
            const mgr = new MCPServerManager();
            await mgr.connectServer(dockerConfig, 'tenant-1');
        } finally {
            vi.unstubAllEnvs();
        }

        expect(StdioCtor).toHaveBeenCalledTimes(1);
        const opts = StdioCtor.mock.calls[0][0];
        expect(opts.command).toBe('npx');
        expect(opts.args).toEqual(['-y', '@leval/mcp-grafana']);
        expect(opts.env.GRAFANA_TOKEN).toBe('secret-token');
    });

    it('throws when docker is unavailable and the image has no known native alternative', async () => {
        mockAvailableCommands(['npx']);
        const unknownImageConfig = { ...dockerConfig, args: ['run', '--rm', 'some/unknown-image'] };
        const mgr = new MCPServerManager();
        await expect(mgr.connectServer(unknownImageConfig, 'tenant-1')).rejects.toThrow(/not found on PATH/);
    });

    it('leaves uvx unchanged (logs a warning) when uvx is missing but npx is available, and still fails to connect', async () => {
        mockAvailableCommands(['npx']);
        const uvxConfig = { id: 'x', name: 'X', description: '', enabled: true, transport: 'stdio' as const, command: 'uvx', args: [] };
        const mgr = new MCPServerManager();
        await expect(mgr.connectServer(uvxConfig, 'tenant-1')).rejects.toThrow(/"uvx" not found on PATH/);
    });

    it('connects directly (no adaptation) when the configured command is already available', async () => {
        mockAvailableCommands(['npx']);
        const npxConfig = { id: 'x', name: 'X', description: '', enabled: true, transport: 'stdio' as const, command: 'npx', args: ['-y', 'some-pkg'] };
        const mgr = new MCPServerManager();
        await mgr.connectServer(npxConfig, 'tenant-1');
        expect(StdioCtor).toHaveBeenCalledTimes(1);
        expect(StdioCtor.mock.calls[0][0].command).toBe('npx');
    });
});

describe('MCPServerManager.connectServer — caching and dedup', () => {
    const config = { id: 'srv', name: 'Srv', description: '', enabled: true, transport: 'http' as const, command: '', args: [], url: 'https://h/mcp' };

    beforeEach(() => {
        clientBehavior.connect = async () => {};
        clientBehavior.listTools = async () => ({ tools: [{ name: 't1' }] });
        ClientCtor.mockClear();
    });

    it('is a no-op the second time the same tenant-scoped server is connected', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(config, 'tenant-1');
        await mgr.connectServer(config, 'tenant-1');
        expect(ClientCtor).toHaveBeenCalledTimes(1);
    });

    it('connects separately per tenant under isolated cache keys', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(config, 'tenant-1');
        await mgr.connectServer(config, 'tenant-2');
        expect(ClientCtor).toHaveBeenCalledTimes(2);
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'srv'))).toBe(true);
        expect(mgr.isConnected(tenantScopedKey('tenant-2', 'srv'))).toBe(true);
    });

    it('coalesces concurrent connect calls for the same key into a single connection', async () => {
        let resolveConnect!: () => void;
        clientBehavior.connect = () => new Promise<void>(resolve => { resolveConnect = resolve; });

        const mgr = new MCPServerManager();
        const first = mgr.connectServer(config, 'tenant-1');
        const second = mgr.connectServer(config, 'tenant-1');
        resolveConnect();
        await Promise.all([first, second]);

        expect(ClientCtor).toHaveBeenCalledTimes(1);
    });

    it('caches an empty tool list (without failing the connection) when listTools throws', async () => {
        clientBehavior.listTools = async () => { throw new Error('discovery failed'); };
        const mgr = new MCPServerManager();
        await mgr.connectServer(config, 'tenant-1');
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'srv'))).toBe(true);
        expect(mgr.getToolsForServers([tenantScopedKey('tenant-1', 'srv')])).toEqual([]);
    });

    it('cleans up client/transport/tool state and rethrows when client.connect fails', async () => {
        clientBehavior.connect = async () => { throw new Error('ECONNREFUSED'); };
        const mgr = new MCPServerManager();
        await expect(mgr.connectServer(config, 'tenant-1')).rejects.toThrow('ECONNREFUSED');
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'srv'))).toBe(false);
    });
});

describe('MCPServerManager.connectServerWithAwsCredentials', () => {
    const stdioConfig = { id: 'aws-srv', name: 'AwsSrv', description: '', enabled: true, transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg'] };
    const httpConfig = { id: 'aws-http', name: 'AwsHttp', description: '', enabled: true, transport: 'http' as const, command: '', args: [], url: 'https://h/mcp' };
    const creds = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', region: 'us-east-1' };

    beforeEach(() => {
        clientBehavior.connect = async () => {};
        clientBehavior.listTools = async () => ({ tools: [{ name: 't' }] });
        StdioCtor.mockClear();
        vi.mocked(createSessionProfile).mockResolvedValue({ profileName: 'nucleus-acc-1', credentialsFile: '/tmp/creds' } as any);
    });

    it('connects a remote (non-stdio) server normally, ignoring AWS credential injection', async () => {
        const mgr = new MCPServerManager();
        const id = await mgr.connectServerWithAwsCredentials(httpConfig, 'acc-1', creds, 'tenant-1');
        expect(id).toBe(tenantScopedKey('tenant-1', 'aws-http'));
        expect(createSessionProfile).not.toHaveBeenCalled();
    });

    it('creates a session profile and injects AWS env vars for a stdio server', async () => {
        const mgr = new MCPServerManager();
        const id = await mgr.connectServerWithAwsCredentials(stdioConfig, 'acc-1', creds, 'tenant-1');

        expect(createSessionProfile).toHaveBeenCalledWith('acc-1', creds, 'tenant-1');
        expect(id).toBe(`${tenantScopedKey('tenant-1', 'aws-srv')}::acc-1`);
        expect(StdioCtor).toHaveBeenCalledTimes(1);
        expect(StdioCtor.mock.calls[0][0].env.AWS_PROFILE).toBe('nucleus-acc-1');
        expect(StdioCtor.mock.calls[0][0].env.AWS_DEFAULT_REGION).toBe('us-east-1');
    });

    it('returns the existing scoped id without reconnecting when already connected', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServerWithAwsCredentials(stdioConfig, 'acc-1', creds, 'tenant-1');
        StdioCtor.mockClear();
        vi.mocked(createSessionProfile).mockClear();

        const id = await mgr.connectServerWithAwsCredentials(stdioConfig, 'acc-1', creds, 'tenant-1');
        expect(id).toBe(`${tenantScopedKey('tenant-1', 'aws-srv')}::acc-1`);
        expect(StdioCtor).not.toHaveBeenCalled();
        expect(createSessionProfile).not.toHaveBeenCalled();
    });
});

describe('MCPServerManager — bulk connect, tool lookup, execution, disconnect', () => {
    const configA = { id: 'a', name: 'A', description: '', enabled: true, transport: 'http' as const, command: '', args: [], url: 'https://h/a' };
    const configB = { id: 'b', name: 'B', description: '', enabled: true, transport: 'http' as const, command: '', args: [], url: 'https://h/b' };

    beforeEach(() => {
        clientBehavior.connect = async () => {};
        clientBehavior.listTools = async () => ({ tools: [{ name: 'do_thing', description: 'd', inputSchema: {} }] });
        clientBehavior.callTool = async () => ({ ok: true });
        clientBehavior.close = async () => {};
    });

    it('connectServers connects every matching config and logs (not throws) on a rejected one', async () => {
        clientBehavior.connect = async () => {
            throw new Error('boom');
        };
        const mgr = new MCPServerManager();
        await expect(mgr.connectServers(['a', 'b'], [configA, configB], 'tenant-1')).resolves.toBeUndefined();
    });

    it('connectServers uses DEFAULT_MCP_SERVERS when no explicit configs are given', async () => {
        const mgr = new MCPServerManager();
        await expect(mgr.connectServers(['nonexistent-id'])).resolves.toBeUndefined();
    });

    it('getAllTools aggregates the tool cache across every connected server', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.connectServer(configB, 'tenant-1');
        expect(mgr.getAllTools().length).toBe(2);
    });

    it('getToolsForServers returns only the requested servers, skipping unknown ids', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        const tools = mgr.getToolsForServers([tenantScopedKey('tenant-1', 'a'), 'unknown-id']);
        expect(tools).toHaveLength(1);
    });

    it('executeTool calls the client and returns its result', async () => {
        clientBehavior.callTool = async (args: any) => ({ echoed: args });
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        const result = await mgr.executeTool(tenantScopedKey('tenant-1', 'a'), 'do_thing', { x: 1 });
        expect(result.echoed).toEqual({ name: 'do_thing', arguments: { x: 1 } });
    });

    it('executeTool throws when the server is not connected', async () => {
        const mgr = new MCPServerManager();
        await expect(mgr.executeTool('not-connected', 'do_thing', {})).rejects.toThrow(/not connected/);
    });

    it('executeTool propagates a tool-call error', async () => {
        clientBehavior.callTool = async () => { throw new Error('tool crashed'); };
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await expect(mgr.executeTool(tenantScopedKey('tenant-1', 'a'), 'do_thing', {})).rejects.toThrow('tool crashed');
    });

    it('getConnectedServerIds lists every connected key', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        expect(mgr.getConnectedServerIds()).toEqual([tenantScopedKey('tenant-1', 'a')]);
    });

    it('disconnectServer tolerates a client.close() failure and still clears state', async () => {
        clientBehavior.close = async () => { throw new Error('close failed'); };
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.disconnectServer(tenantScopedKey('tenant-1', 'a'));
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'a'))).toBe(false);
    });

    it('disconnectServer tolerates a transport.close() failure and still clears state', async () => {
        HttpCtor.mockImplementationOnce(function (this: any, url: any, opts: any) {
            this.kind = 'http'; this.url = url; this.opts = opts;
            this.close = async () => { throw new Error('transport close failed'); };
        });
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.disconnectServer(tenantScopedKey('tenant-1', 'a'));
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'a'))).toBe(false);
    });

    it('disconnectServer is a safe no-op for an id that was never connected', async () => {
        const mgr = new MCPServerManager();
        await expect(mgr.disconnectServer('never-connected')).resolves.toBeUndefined();
    });

    it('disconnectAccountScopedServers disconnects only that server\'s account-scoped instances', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.connectServerWithAwsCredentials(
            { ...configA, transport: 'stdio' as const, command: 'npx', args: [] },
            'acc-1',
            { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', region: 'us-east-1' },
            'tenant-1',
        );
        await mgr.disconnectAccountScopedServers('a');
        expect(mgr.isConnected(`${tenantScopedKey('tenant-1', 'a')}::acc-1`)).toBe(false);
        expect(mgr.isConnected(tenantScopedKey('tenant-1', 'a'))).toBe(true);
    });

    it('disconnectTenantServers disconnects every instance for that tenant and no-ops for an empty tenant', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.connectServer(configB, 'tenant-1');
        await mgr.disconnectTenantServers('tenant-empty');
        expect(mgr.getConnectedServerIds()).toHaveLength(2);

        await mgr.disconnectTenantServers('tenant-1');
        expect(mgr.getConnectedServerIds()).toHaveLength(0);
    });

    it('disconnectAll clears every connected server', async () => {
        const mgr = new MCPServerManager();
        await mgr.connectServer(configA, 'tenant-1');
        await mgr.connectServer(configB, 'tenant-1');
        await mgr.disconnectAll();
        expect(mgr.getConnectedServerIds()).toHaveLength(0);
    });
});

describe('getMCPManager (global singleton)', () => {
    afterEach(() => {
        delete (globalThis as any).mcpManager;
    });

    it('creates the manager once and reuses it on subsequent calls', () => {
        const a = getMCPManager();
        const b = getMCPManager();
        expect(a).toBe(b);
        expect(a).toBeInstanceOf(MCPServerManager);
    });
});
