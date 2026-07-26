/**
 * SubagentRunPostgresRepository
 *
 * PostgreSQL implementation of SubagentRunRepository using Prisma ORM.
 * Reads/writes the `agent_subagent_runs` table (defined in libs/prisma/schema.prisma).
 *
 * AgentSubagentRun is listed in TENANT_SCOPED_MODELS, so getTenantClient() injects
 * tenantId into every read and write here — a caller cannot reach another tenant's
 * transcript by supplying its threadId.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import { redactTranscript } from '@/lib/agent/subagent-redact';
import type { SubagentRunRecord, SubagentRunRepository, SubagentTranscriptEntry } from './interface';

const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class SubagentRunPostgresRepository implements SubagentRunRepository {
    async save(record: SubagentRunRecord): Promise<void> {
        const db = getTenantClient(record.tenantId);
        const data = {
            tenantId: record.tenantId,
            threadId: record.threadId,
            subagentId: record.subagentId,
            role: record.role,
            task: record.task,
            status: record.status,
            toolCount: record.toolCount,
            tokensIn: record.tokensIn,
            tokensOut: record.tokensOut,
            // Redacted HERE rather than at the call site so no caller can bypass it.
            // aws_read permits `lambda get-function-configuration`, which returns
            // Environment.Variables in plaintext; those must never reach at-rest storage.
            // The summary is redacted too: it is LLM-authored prose that can quote a
            // secret the sub-agent saw, and it is the one field still shown after a
            // reload when the transcript is empty.
            summary: redactTranscript(record.summary ?? null),
            transcript: redactTranscript(record.transcript ?? null) as never,
            expiresAt: new Date(Date.now() + TTL_30_DAYS_MS),
        };

        await db.agentSubagentRun.upsert({
            where: {
                tenantId_threadId_subagentId: {
                    tenantId: record.tenantId,
                    threadId: record.threadId,
                    subagentId: record.subagentId,
                },
            },
            create: data,
            update: data,
        });
    }

    async listByThread(tenantId: string, threadId: string): Promise<SubagentRunRecord[]> {
        const db = getTenantClient(tenantId);
        const rows = await db.agentSubagentRun.findMany({
            where: { threadId },
            orderBy: { createdAt: 'asc' },
        });

        return rows.map(row => ({
            tenantId: row.tenantId,
            threadId: row.threadId,
            subagentId: row.subagentId,
            role: row.role,
            task: row.task,
            status: row.status,
            toolCount: row.toolCount,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
            summary: row.summary,
            transcript: (row.transcript ?? null) as SubagentTranscriptEntry[] | null,
        }));
    }
}
