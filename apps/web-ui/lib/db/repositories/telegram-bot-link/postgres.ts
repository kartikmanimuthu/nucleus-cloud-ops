/**
 * TelegramBotLinkPostgresRepository
 *
 * PostgreSQL implementation of ITelegramBotLinkRepository using Prisma ORM.
 * Reads/writes the `telegram_bot_links` table (defined in libs/prisma/schema.prisma).
 *
 * findTenantIdBySecretToken is intentionally NOT tenant-scoped — resolving
 * which tenant owns an inbound secret token is the whole point of this table,
 * so it uses the unscoped Prisma client rather than getTenantClient().
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import {
    TelegramBotLinkConflictError,
    type ITelegramBotLinkRepository,
    type TelegramBotLinkRecord,
} from './interface';

export class TelegramBotLinkPostgresRepository implements ITelegramBotLinkRepository {
    async findTenantIdBySecretToken(secretToken: string): Promise<string | null> {
        try {
            const record = await getPrismaClient().telegramBotLink.findUnique({
                where: { secretToken },
                select: { tenantId: true },
            });
            return record?.tenantId ?? null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TelegramBotLinkPostgresRepository] Error resolving secretToken:', error);
            throw new Error(`Failed to resolve Telegram secret token: ${msg}`);
        }
    }

    async upsertLink(params: { secretToken: string; tenantId: string }): Promise<void> {
        const { secretToken, tenantId } = params;
        try {
            const existing = await getPrismaClient().telegramBotLink.findUnique({
                where: { secretToken },
                select: { tenantId: true },
            });
            if (existing && existing.tenantId !== tenantId) {
                throw new TelegramBotLinkConflictError();
            }

            await getPrismaClient().telegramBotLink.upsert({
                where: { secretToken },
                update: {},
                create: { secretToken, tenantId },
            });
            console.log(`[TelegramBotLinkPostgresRepository] Linked Telegram bot to tenant "${tenantId}"`);
        } catch (error: unknown) {
            if (error instanceof TelegramBotLinkConflictError) throw error;
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TelegramBotLinkPostgresRepository] Error upserting link:', error);
            throw new Error(`Failed to link Telegram bot: ${msg}`);
        }
    }

    async getLinkForTenant(tenantId: string): Promise<TelegramBotLinkRecord | null> {
        try {
            const record = await getPrismaClient().telegramBotLink.findFirst({
                where: { tenantId },
            });
            if (!record) return null;
            return { secretToken: record.secretToken, tenantId: record.tenantId };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TelegramBotLinkPostgresRepository] Error getting link for tenant:', error);
            throw new Error(`Failed to get Telegram bot link: ${msg}`);
        }
    }

    async deleteLinkForTenant(tenantId: string): Promise<number> {
        try {
            const { count } = await getPrismaClient().telegramBotLink.deleteMany({
                where: { tenantId },
            });
            if (count > 0) {
                console.log(`[TelegramBotLinkPostgresRepository] Unlinked Telegram bot for tenant "${tenantId}"`);
            }
            return count;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[TelegramBotLinkPostgresRepository] Error deleting link for tenant:', error);
            throw new Error(`Failed to unlink Telegram bot: ${msg}`);
        }
    }
}
