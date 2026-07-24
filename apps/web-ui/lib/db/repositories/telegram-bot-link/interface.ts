/**
 * ITelegramBotLinkRepository
 *
 * Reverse index from a Telegram bot's webhook secret token to the tenant that
 * registered it. Inbound Telegram updates carry no tenant-identifying field at
 * all, so the secret token echoed back in the X-Telegram-Bot-Api-Secret-Token
 * header is the only value that can resolve which tenant a request belongs to.
 */
export interface TelegramBotLinkRecord {
    secretToken: string;
    tenantId: string;
}

/** Thrown when a secret token is already linked to a different tenant. */
export class TelegramBotLinkConflictError extends Error {
    constructor() {
        super('This secret token is already linked to a different tenant');
        this.name = 'TelegramBotLinkConflictError';
    }
}

export interface ITelegramBotLinkRepository {
    /**
     * Resolve the tenantId that owns a Telegram bot by its secret token.
     * Returns null if no tenant has linked this secret token.
     */
    findTenantIdBySecretToken(secretToken: string): Promise<string | null>;

    /**
     * Link a secret token to a tenant (upsert on secretToken). Throws if the
     * secretToken is already linked to a *different* tenant — a secret token
     * can only ever belong to one tenant.
     */
    upsertLink(params: { secretToken: string; tenantId: string }): Promise<void>;

    /**
     * Look up the current link for a tenant, if any.
     */
    getLinkForTenant(tenantId: string): Promise<TelegramBotLinkRecord | null>;

    /**
     * Drop a tenant's bot link. Called when the tenant rotates or resets its
     * Telegram configuration: a stale link left behind would keep routing
     * inbound requests for the old secret to a tenant that no longer holds it.
     * Returns the number of rows removed (0 when the tenant had no link).
     */
    deleteLinkForTenant(tenantId: string): Promise<number>;
}
