import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('@/lib/audit-service', () => ({ AuditService: { logResourceAction: vi.fn().mockResolvedValue(undefined) } }));

const mockEnv = vi.hoisted(() => ({ TAVILY_API_KEY: undefined as string | undefined, APP_BUCKET_NAME: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));

const s3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function (this: any) { this.send = s3Send; }),
    PutObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    GetObjectCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

const execMock = vi.fn();
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (orig) => {
    const actual = await orig<typeof import('util')>();
    return { ...actual, promisify: () => execMock };
});

import { AuditService } from '@/lib/audit-service';

let AGENT_WORKDIR: string;
let tools: typeof import('./tools');

beforeAll(async () => {
    AGENT_WORKDIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
    process.env.AGENT_WORKDIR = AGENT_WORKDIR;
    tools = await import('./tools');
});

afterAll(async () => {
    delete process.env.AGENT_WORKDIR;
    await fsp.rm(AGENT_WORKDIR, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TAVILY_API_KEY = undefined;
    mockEnv.APP_BUCKET_NAME = undefined;
});

describe('buildCommandEnv', () => {
    it('copies only allowlisted keys from process.env and drops everything else', () => {
        vi.stubEnv('PATH', '/usr/bin');
        vi.stubEnv('AWS_REGION', 'us-east-1');
        vi.stubEnv('DATABASE_URL', 'postgres://leak-me');
        try {
            const result = tools.buildCommandEnv();
            expect(result.PATH).toBe('/usr/bin');
            expect(result.AWS_REGION).toBe('us-east-1');
            expect(result).not.toHaveProperty('DATABASE_URL');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('pins AWS_SHARED_CREDENTIALS_FILE and AWS_CONFIG_FILE for a tenant', () => {
        const result = tools.buildCommandEnv('tenant-1');
        expect(result.AWS_SHARED_CREDENTIALS_FILE).toContain('tenant-1');
        expect(result.AWS_CONFIG_FILE).toContain('tenant-1');
    });

    it('omits tenant credential file paths when no tenantId is given', () => {
        const result = tools.buildCommandEnv();
        expect(result.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
        expect(result.AWS_CONFIG_FILE).toBeUndefined();
    });

    it('never inherits AWS static credential env vars even when present in the parent process', () => {
        vi.stubEnv('AWS_ACCESS_KEY_ID', 'leak');
        vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'leak');
        vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/leak');
        try {
            const result = tools.buildCommandEnv();
            expect(result).not.toHaveProperty('AWS_ACCESS_KEY_ID');
            expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
            expect(result).not.toHaveProperty('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('execute_command tool', () => {

    it('returns stdout and logs a success audit event', async () => {
        execMock.mockResolvedValue({ stdout: 'hello\n', stderr: '' });
        const result = await tools.executeCommandTool.invoke(
            { command: 'echo hello' },
            { configurable: { tenant_id: 'tenant-1', user_id: 'user-1' } },
        );
        expect(result).toBe('hello\n');
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.tool.execute_command', status: 'success', user: 'user-1', tenantId: 'tenant-1' }),
        );
    });

    it('falls back to stderr when stdout is empty', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: 'warn output' });
        const result = await tools.executeCommandTool.invoke({ command: 'x' });
        expect(result).toBe('warn output');
    });

    it('reports success with no output when both stdout and stderr are empty', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: '' });
        const result = await tools.executeCommandTool.invoke({ command: 'true' });
        expect(result).toBe('Command executed successfully (no output)');
    });

    it('truncates output beyond the length cap', async () => {
        execMock.mockResolvedValue({ stdout: 'x'.repeat(100010), stderr: '' });
        const result = await tools.executeCommandTool.invoke({ command: 'big' });
        expect(result.length).toBeLessThan(100200);
        expect(result).toContain('Output truncated due to length');
    });

    it('returns a formatted error and logs an error audit event on failure, attributing to "agent" with no user_id', async () => {
        execMock.mockRejectedValue(Object.assign(new Error('boom'), { stderr: 'stderr detail' }));
        const result = await tools.executeCommandTool.invoke({ command: 'false' });
        expect(result).toContain('Command failed: boom');
        expect(result).toContain('stderr detail');
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'error', user: 'agent', userType: 'system' }),
        );
    });

    it('does not block or fail when the audit write itself rejects', async () => {
        execMock.mockResolvedValue({ stdout: 'ok', stderr: '' });
        vi.mocked(AuditService.logResourceAction).mockRejectedValue(new Error('audit db down'));
        await expect(tools.executeCommandTool.invoke({ command: 'echo ok' })).resolves.toBe('ok');
    });

    it('createExecuteCommandTool runs commands scoped to the provided cwd', async () => {
        execMock.mockResolvedValue({ stdout: 'scoped', stderr: '' });
        const scoped = tools.createExecuteCommandTool({ cwd: '/tmp/scoped' });
        const result = await scoped.invoke({ command: 'pwd' });
        expect(result).toBe('scoped');
        expect(execMock.mock.calls[0][1]).toMatchObject({ cwd: '/tmp/scoped' });
    });
});

describe('lsTool', () => {
    it('lists directory contents with type/size/modified metadata', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'a.txt'), 'hi');
        await fsp.mkdir(path.join(AGENT_WORKDIR, 'subdir'), { recursive: true });

        const result = await tools.lsTool.invoke({ path: '.' });
        expect(result).toContain('a.txt');
        expect(result).toContain('subdir');
        expect(result).toContain('DIR');
        expect(result).toContain('FILE');
    });

    it('rejects a path outside the jail', async () => {
        const result = await tools.lsTool.invoke({ path: '../../etc' });
        expect(result).toContain('outside the agent working directory');
    });

    it('errors when the target is not a directory', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'plain.txt'), 'hi');
        const result = await tools.lsTool.invoke({ path: 'plain.txt' });
        expect(result).toContain('is not a directory');
    });

    it('returns an error message when the directory does not exist', async () => {
        const result = await tools.lsTool.invoke({ path: 'does-not-exist' });
        expect(result).toContain('Error listing directory');
    });
});

describe('readFileTool', () => {
    it('reads a whole file with line numbers', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'read.txt'), 'line1\nline2\nline3');
        const result = await tools.readFileTool.invoke({ file_path: 'read.txt' });
        expect(result).toBe('1: line1\n2: line2\n3: line3');
    });

    it('reads a specific line range', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'range.txt'), 'a\nb\nc\nd');
        const result = await tools.readFileTool.invoke({ file_path: 'range.txt', start_line: 2, end_line: 3 });
        expect(result).toBe('2: b\n3: c');
    });

    it('errors when start_line is beyond the file length', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'short.txt'), 'a\nb');
        const result = await tools.readFileTool.invoke({ file_path: 'short.txt', start_line: 99 });
        expect(result).toContain('is beyond file length');
    });

    it('rejects a path outside the jail', async () => {
        const result = await tools.readFileTool.invoke({ file_path: '/etc/passwd' });
        expect(result).toContain('outside the agent working directory');
    });

    it('returns an error message when the file does not exist', async () => {
        const result = await tools.readFileTool.invoke({ file_path: 'missing.txt' });
        expect(result).toContain('Error reading file');
    });
});

describe('writeFileTool', () => {
    it('writes a new file, creating parent directories', async () => {
        const result = await tools.writeFileTool.invoke({ file_path: 'nested/dir/out.txt', content: 'payload' });
        expect(result).toContain('Successfully written');
        expect(await fsp.readFile(path.join(AGENT_WORKDIR, 'nested/dir/out.txt'), 'utf-8')).toBe('payload');
    });

    it('rejects a missing or non-string file_path', async () => {
        const result = await tools.writeFileTool.invoke({ file_path: '', content: 'x' } as any);
        expect(result).toContain('file_path is required');
    });

    it('rejects null or undefined content (defense-in-depth guard behind the zod schema)', async () => {
        const result = await (tools.writeFileTool as any).func({ file_path: 'x.txt', content: null });
        expect(result).toContain('content is required');
    });

    it('rejects a path outside the jail', async () => {
        const result = await tools.writeFileTool.invoke({ file_path: '../escape.txt', content: 'x' });
        expect(result).toContain('outside the agent working directory');
    });
});

describe('editFileTool', () => {
    it('applies a sequence of exact-string edits', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'edit.txt'), 'hello world');
        const result = await tools.editFileTool.invoke({
            file_path: 'edit.txt',
            edits: [{ old_string: 'world', new_string: 'there' }],
        });
        expect(result).toContain('Successfully applied 1 edit(s)');
        expect(await fsp.readFile(path.join(AGENT_WORKDIR, 'edit.txt'), 'utf-8')).toBe('hello there');
    });

    it('reports when the target string is not found', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'edit2.txt'), 'hello world');
        const result = await tools.editFileTool.invoke({
            file_path: 'edit2.txt',
            edits: [{ old_string: 'missing', new_string: 'x' }],
        });
        expect(result).toContain('Target string not found');
    });

    it('reports no changes when old_string equals new_string', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'edit3.txt'), 'same');
        const result = await tools.editFileTool.invoke({
            file_path: 'edit3.txt',
            edits: [{ old_string: 'same', new_string: 'same' }],
        });
        expect(result).toBe('No changes made (content matched existing state).');
    });

    it('previews without writing when dry_run is true', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'edit4.txt'), 'dry me');
        const result = await tools.editFileTool.invoke({
            file_path: 'edit4.txt',
            edits: [{ old_string: 'dry', new_string: 'wet' }],
            dry_run: true,
        });
        expect(result).toContain('[DRY RUN]');
        expect(await fsp.readFile(path.join(AGENT_WORKDIR, 'edit4.txt'), 'utf-8')).toBe('dry me');
    });

    it('escapes regex-special characters in old_string', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'edit5.txt'), 'price: $5.00 (each)');
        const result = await tools.editFileTool.invoke({
            file_path: 'edit5.txt',
            edits: [{ old_string: '$5.00 (each)', new_string: '$6.00 (each)' }],
        });
        expect(result).toContain('Successfully applied');
        expect(await fsp.readFile(path.join(AGENT_WORKDIR, 'edit5.txt'), 'utf-8')).toBe('price: $6.00 (each)');
    });

    it('rejects a path outside the jail', async () => {
        const result = await tools.editFileTool.invoke({ file_path: '../escape.txt', edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(result).toContain('outside the agent working directory');
    });

    it('returns an error message when the file does not exist', async () => {
        const result = await tools.editFileTool.invoke({ file_path: 'nope.txt', edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(result).toContain('Error editing file');
    });
});

describe('globTool', () => {

    it('returns matching files', async () => {
        execMock.mockResolvedValue({ stdout: `${AGENT_WORKDIR}/a.ts\n${AGENT_WORKDIR}/b.ts\n`, stderr: '' });
        const result = await tools.globTool.invoke({ pattern: '*.ts' });
        expect(result).toContain('a.ts');
        expect(result).toContain('b.ts');
    });

    it('reports no matches found', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: '' });
        const result = await tools.globTool.invoke({ pattern: '*.nomatch' });
        expect(result).toBe('No matching files found.');
    });

    it('truncates a list of more than 100 matches', async () => {
        const many = Array.from({ length: 150 }, (_, i) => `${AGENT_WORKDIR}/f${i}.ts`).join('\n');
        execMock.mockResolvedValue({ stdout: many, stderr: '' });
        const result = await tools.globTool.invoke({ pattern: '*.ts' });
        expect(result).toContain('Found 150 files');
        expect(result).toContain('and 50 more');
    });

    it('strips shell metacharacters from the pattern before shelling out', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: '' });
        await tools.globTool.invoke({ pattern: '*.ts`$(rm -rf /)`' });
        expect(execMock.mock.calls[0][0]).not.toMatch(/[`$]/);
    });

    it('errors when the base directory does not exist', async () => {
        const result = await tools.globTool.invoke({ pattern: '*.ts', path: 'nope' });
        expect(result).toContain("does not exist");
    });

    it('rejects a base path outside the jail', async () => {
        const result = await tools.globTool.invoke({ pattern: '*.ts', path: '../../etc' });
        expect(result).toContain('outside the agent working directory');
    });

    it('returns a Glob error message when find itself fails', async () => {
        execMock.mockRejectedValue(new Error('find exploded'));
        const result = await tools.globTool.invoke({ pattern: '*.ts' });
        expect(result).toContain('Glob error: find exploded');
    });
});

describe('grepTool', () => {

    it('searches specific files and resolves them inside the jail', async () => {
        await fsp.writeFile(path.join(AGENT_WORKDIR, 'g.txt'), 'needle');
        execMock.mockResolvedValue({ stdout: `${AGENT_WORKDIR}/g.txt\n`, stderr: '' });
        const result = await tools.grepTool.invoke({ pattern: 'needle', file_paths: ['g.txt'] });
        expect(result).toContain('g.txt');
        expect(execMock.mock.calls[0][0]).toContain(path.join(AGENT_WORKDIR, 'g.txt'));
    });

    it('rejects a file path outside the jail', async () => {
        const result = await tools.grepTool.invoke({ pattern: 'x', file_paths: ['../../etc/passwd'] });
        expect(result).toContain('outside the agent working directory');
    });

    it('searches recursively with line numbers when requested', async () => {
        execMock.mockResolvedValue({ stdout: 'match line\n', stderr: '' });
        const result = await tools.grepTool.invoke({ pattern: 'match', recursive: true, include_lines: true });
        expect(execMock.mock.calls[0][0]).toContain('grep -n -r');
        expect(result).toBe('match line\n');
    });

    it('returns "No matches found" when grep produces no output', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: '' });
        const result = await tools.grepTool.invoke({ pattern: 'nothing' });
        expect(result).toBe('No matches found.');
    });

    it('treats exit code 1 as "no matches" rather than an error', async () => {
        execMock.mockRejectedValue(Object.assign(new Error('no match'), { code: 1 }));
        const result = await tools.grepTool.invoke({ pattern: 'nothing' });
        expect(result).toBe('No matches found.');
    });

    it('returns a Grep error for any other failure', async () => {
        execMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 2 }));
        const result = await tools.grepTool.invoke({ pattern: 'x' });
        expect(result).toContain('Grep error: permission denied');
    });

    it('escapes double quotes in the search pattern', async () => {
        execMock.mockResolvedValue({ stdout: '', stderr: '' });
        await tools.grepTool.invoke({ pattern: 'say "hi"' });
        expect(execMock.mock.calls[0][0]).toContain('say \\"hi\\"');
    });
});

describe('webSearchAvailable', () => {
    it('is false when no API key is configured', () => {
        expect(tools.webSearchAvailable()).toBe(false);
    });

    it('is true when TAVILY_API_KEY is set', () => {
        mockEnv.TAVILY_API_KEY = 'tvly-1';
        expect(tools.webSearchAvailable()).toBe(true);
    });
});

describe('webSearchTool', () => {
    beforeEach(() => vi.unstubAllGlobals());

    it('refuses to fabricate results when no API key is configured', async () => {
        const result = await tools.webSearchTool.invoke({ query: 'aws pricing' });
        expect(result).toContain('WEB SEARCH UNAVAILABLE');
    });

    it('returns the answer and top sources on success', async () => {
        mockEnv.TAVILY_API_KEY = 'tvly-1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                answer: 'The answer',
                results: [{ title: 'Doc', url: 'https://x.com', content: 'c'.repeat(300) }],
            }),
        }));
        const result = await tools.webSearchTool.invoke({ query: 'aws pricing' });
        expect(result).toContain('**Answer:** The answer');
        expect(result).toContain('[Doc](https://x.com)');
    });

    it('returns "No results found." when the API returns nothing usable', async () => {
        mockEnv.TAVILY_API_KEY = 'tvly-1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
        const result = await tools.webSearchTool.invoke({ query: 'x' });
        expect(result).toBe('No results found.');
    });

    it('returns an error message on a non-ok response', async () => {
        mockEnv.TAVILY_API_KEY = 'tvly-1';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' }));
        const result = await tools.webSearchTool.invoke({ query: 'x' });
        expect(result).toContain('Web search error');
        expect(result).toContain('500');
    });

    it('returns an error message when fetch itself throws', async () => {
        mockEnv.TAVILY_API_KEY = 'tvly-1';
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const result = await tools.webSearchTool.invoke({ query: 'x' });
        expect(result).toContain('Web search error: network down');
    });
});

describe('writeFileToS3Tool', () => {
    it('errors when APP_BUCKET_NAME is not configured', async () => {
        const result = await tools.writeFileToS3Tool.invoke({ key: 'a.txt', content: 'x', thread_id: 't1' });
        expect(result).toContain('APP_BUCKET_NAME environment variable is not set');
    });

    it('writes the content under a per-thread namespaced key', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        s3Send.mockResolvedValue({});
        const result = await tools.writeFileToS3Tool.invoke({ key: 'a.txt', content: 'x', thread_id: 'thread/1' });
        expect(result).toContain('s3://bucket-1/agent-temp/thread_1/a.txt');
    });

    it('returns an error message when the S3 write fails', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        s3Send.mockRejectedValue(new Error('access denied'));
        const result = await tools.writeFileToS3Tool.invoke({ key: 'a.txt', content: 'x', thread_id: 't1' });
        expect(result).toContain('Error writing file to S3: access denied');
    });
});

describe('getFileFromS3Tool', () => {
    it('errors when APP_BUCKET_NAME is not configured', async () => {
        const result = await tools.getFileFromS3Tool.invoke({ key: 'a.txt', thread_id: 't1' });
        expect(result).toContain('APP_BUCKET_NAME environment variable is not set');
    });

    it('reads a streamed body back into a string', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        const { Readable } = await import('stream');
        s3Send.mockResolvedValue({ Body: Readable.from([Buffer.from('file contents')]) });
        const result = await tools.getFileFromS3Tool.invoke({ key: 'a.txt', thread_id: 't1' });
        expect(result).toBe('file contents');
    });

    it('errors when the response has no Body', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        s3Send.mockResolvedValue({});
        const result = await tools.getFileFromS3Tool.invoke({ key: 'a.txt', thread_id: 't1' });
        expect(result).toBe('Error: Empty response body from S3.');
    });

    it('returns an error message when the S3 read fails', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        s3Send.mockRejectedValue(new Error('not found'));
        const result = await tools.getFileFromS3Tool.invoke({ key: 'a.txt', thread_id: 't1' });
        expect(result).toContain('Error reading file from S3: not found');
    });

    it('rejects a stream error while buffering the body', async () => {
        mockEnv.APP_BUCKET_NAME = 'bucket-1';
        const { Readable } = await import('stream');
        const badStream = new Readable({
            read() {
                this.emit('error', new Error('stream broke'));
            },
        });
        s3Send.mockResolvedValue({ Body: badStream });
        const result = await tools.getFileFromS3Tool.invoke({ key: 'a.txt', thread_id: 't1' });
        expect(result).toContain('Error reading file from S3: stream broke');
    });
});

describe('askUserTool', () => {
    it('never fabricates an answer if it is ever invoked directly', async () => {
        const result = await tools.askUserTool.invoke({ question: 'Which account?' });
        expect(result).toContain('No answer was provided for: "Which account?"');
    });
});
