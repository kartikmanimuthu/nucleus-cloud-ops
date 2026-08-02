/**
 * The redaction guarantee is asserted HERE, at the repository, because that is where
 * it is enforced — every present and future caller of save() is covered and none can
 * forget. These tests inspect the argument actually handed to Prisma's upsert rather
 * than asserting the redactor was called, so deleting the redactTranscript(...) wrapper
 * in postgres.ts fails them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.fn();
const findMany = vi.fn();
const getTenantClient = vi.fn(() => ({ agentSubagentRun: { upsert, findMany } }));

vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: (...args: unknown[]) => getTenantClient(...(args as [])) }));

import { SubagentRunPostgresRepository } from './postgres';
import { REDACTED } from '@/lib/agent/subagent-redact';
import type { SubagentRunRecord } from './interface';

const repo = new SubagentRunPostgresRepository();

const LAMBDA_CONFIG = JSON.stringify({
    FunctionName: 'api-worker',
    Environment: { Variables: { DB_PASSWORD: 'hunter2' } },
});

const record = (overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord => ({
    tenantId: 't1',
    threadId: 'thread-1',
    subagentId: 'sub-1',
    role: 'Cost auditor',
    task: 'Audit lambda config',
    status: 'done',
    toolCount: 2,
    tokensIn: 100,
    tokensOut: 50,
    summary: 'Nothing unusual.',
    transcript: [{ kind: 'tool', name: 'aws_read', text: LAMBDA_CONFIG }],
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    upsert.mockResolvedValue({});
    findMany.mockResolvedValue([]);
});

describe('SubagentRunPostgresRepository.save', () => {
    it('redacts Environment.Variables out of the persisted transcript', async () => {
        await repo.save(record());

        const args = upsert.mock.calls[0][0];
        for (const payload of [args.create, args.update]) {
            expect(JSON.stringify(payload.transcript)).toContain(REDACTED);
            expect(JSON.stringify(payload.transcript)).not.toContain('hunter2');
        }
        // Nothing anywhere in the write may carry the plaintext.
        expect(JSON.stringify(args)).not.toContain('hunter2');
    });

    it('redacts the LLM-authored summary too — it is shown even when the transcript is empty', async () => {
        await repo.save(record({
            transcript: [],
            summary: 'The function is misconfigured; DB_PASSWORD=hunter2 is set in plaintext.',
        }));

        const args = upsert.mock.calls[0][0];
        expect(args.create.summary).toContain(REDACTED);
        expect(JSON.stringify(args)).not.toContain('hunter2');
    });

    it('upserts on (tenantId, threadId, subagentId) so a retried write cannot duplicate', async () => {
        await repo.save(record());

        const args = upsert.mock.calls[0][0];
        expect(args.where.tenantId_threadId_subagentId).toEqual({
            tenantId: 't1', threadId: 'thread-1', subagentId: 'sub-1',
        });
        expect(getTenantClient).toHaveBeenCalledWith('t1');
    });

    it('preserves non-secret fields and sets a 30-day TTL', async () => {
        const before = Date.now();
        await repo.save(record({ transcript: [{ kind: 'ai', text: 'Checked 3 accounts.' }] }));

        const { create } = upsert.mock.calls[0][0];
        expect(create.role).toBe('Cost auditor');
        expect(create.toolCount).toBe(2);
        expect(create.tokensIn).toBe(100);
        expect(create.transcript[0].text).toBe('Checked 3 accounts.');
        expect(create.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 29 * 24 * 60 * 60 * 1000);
    });

    it('writes null rather than undefined for an absent transcript', async () => {
        await repo.save(record({ transcript: null, summary: null }));

        const { create } = upsert.mock.calls[0][0];
        expect(create.transcript).toBeNull();
        expect(create.summary).toBeNull();
    });
});

describe('SubagentRunPostgresRepository.listByThread', () => {
    it('reads through the tenant-scoped client', async () => {
        findMany.mockResolvedValue([{
            tenantId: 't1', threadId: 'thread-1', subagentId: 'sub-1',
            role: 'R', task: 'T', status: 'done', toolCount: 1, tokensIn: 2, tokensOut: 3,
            summary: 's', transcript: [{ kind: 'ai', text: 'x' }],
        }]);

        const rows = await repo.listByThread('t1', 'thread-1');

        expect(getTenantClient).toHaveBeenCalledWith('t1');
        expect(findMany).toHaveBeenCalledWith({
            where: { threadId: 'thread-1' },
            orderBy: { createdAt: 'asc' },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].transcript).toEqual([{ kind: 'ai', text: 'x' }]);
    });

    it('maps a null transcript to null', async () => {
        findMany.mockResolvedValue([{
            tenantId: 't1', threadId: 'thread-1', subagentId: 'sub-1',
            role: 'R', task: 'T', status: 'failed', toolCount: 0, tokensIn: 0, tokensOut: 0,
            summary: null, transcript: null,
        }]);

        expect((await repo.listByThread('t1', 'thread-1'))[0].transcript).toBeNull();
    });
});
