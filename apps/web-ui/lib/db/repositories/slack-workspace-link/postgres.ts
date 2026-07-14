/**
 * SlackWorkspaceLinkPostgresRepository
 *
 * PostgreSQL implementation of ISlackWorkspaceLinkRepository using Prisma ORM.
 * Reads/writes the `slack_workspace_links` table (defined in libs/prisma/schema.prisma).
 *
 * findTenantIdByTeamId is intentionally NOT tenant-scoped — resolving which
 * tenant owns an inbound Slack team_id is the whole point of this table, so
 * it uses the unscoped Prisma client rather than getTenantClient().
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import {
    SlackWorkspaceLinkConflictError,
    type ISlackWorkspaceLinkRepository,
    type SlackWorkspaceLinkRecord,
} from './interface';

export class SlackWorkspaceLinkPostgresRepository implements ISlackWorkspaceLinkRepository {
    async findTenantIdByTeamId(teamId: string): Promise<string | null> {
        try {
            const record = await getPrismaClient().slackWorkspaceLink.findUnique({
                where: { teamId },
                select: { tenantId: true },
            });
            return record?.tenantId ?? null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SlackWorkspaceLinkPostgresRepository] Error resolving teamId:', error);
            throw new Error(`Failed to resolve Slack team_id: ${msg}`);
        }
    }

    async upsertLink(params: { teamId: string; tenantId: string; botUserId?: string | null }): Promise<void> {
        const { teamId, tenantId, botUserId = null } = params;
        try {
            const existing = await getPrismaClient().slackWorkspaceLink.findUnique({
                where: { teamId },
                select: { tenantId: true },
            });
            if (existing && existing.tenantId !== tenantId) {
                throw new SlackWorkspaceLinkConflictError(teamId);
            }

            await getPrismaClient().slackWorkspaceLink.upsert({
                where: { teamId },
                update: { botUserId },
                create: { teamId, tenantId, botUserId },
            });
            console.log(`[SlackWorkspaceLinkPostgresRepository] Linked team "${teamId}" to tenant "${tenantId}"`);
        } catch (error: unknown) {
            if (error instanceof SlackWorkspaceLinkConflictError) throw error;
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SlackWorkspaceLinkPostgresRepository] Error upserting link:', error);
            throw new Error(`Failed to link Slack workspace: ${msg}`);
        }
    }

    async getLinkForTenant(tenantId: string): Promise<SlackWorkspaceLinkRecord | null> {
        try {
            const record = await getPrismaClient().slackWorkspaceLink.findFirst({
                where: { tenantId },
            });
            if (!record) return null;
            return { teamId: record.teamId, tenantId: record.tenantId, botUserId: record.botUserId };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SlackWorkspaceLinkPostgresRepository] Error getting link for tenant:', error);
            throw new Error(`Failed to get Slack workspace link: ${msg}`);
        }
    }

    async deleteLinkForTenant(tenantId: string): Promise<number> {
        try {
            const { count } = await getPrismaClient().slackWorkspaceLink.deleteMany({
                where: { tenantId },
            });
            if (count > 0) {
                console.log(`[SlackWorkspaceLinkPostgresRepository] Unlinked Slack workspace for tenant "${tenantId}"`);
            }
            return count;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SlackWorkspaceLinkPostgresRepository] Error deleting link for tenant:', error);
            throw new Error(`Failed to unlink Slack workspace: ${msg}`);
        }
    }
}
