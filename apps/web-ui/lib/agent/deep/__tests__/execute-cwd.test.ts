import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (orig) => {
    const actual = await orig<typeof import('util')>();
    return { ...actual, promisify: () => execMock };
});

describe('createExecuteCommandTool', () => {
    beforeEach(() => {
        execMock.mockReset();
        execMock.mockResolvedValue({ stdout: 'ok', stderr: '' });
    });

    it('runs the command with the configured cwd', async () => {
        const { createExecuteCommandTool } = await import('@/lib/agent/tools');
        const tool = createExecuteCommandTool({ cwd: '/tmp/nucleus-agent/tenant-a' });

        await tool.invoke(
            { command: 'echo hi' },
            { configurable: { tenant_id: 'tenant-a' } },
        );

        expect(execMock).toHaveBeenCalledTimes(1);
        expect(execMock.mock.calls[0][1]).toMatchObject({ cwd: '/tmp/nucleus-agent/tenant-a' });
    });

    it('is named execute_command so it does not collide with a deepagents builtin', async () => {
        const { createExecuteCommandTool } = await import('@/lib/agent/tools');
        expect(createExecuteCommandTool({ cwd: '/tmp/x' }).name).toBe('execute_command');
    });
});
