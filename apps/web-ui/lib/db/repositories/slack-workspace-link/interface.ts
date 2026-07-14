/**
 * ISlackWorkspaceLinkRepository
 *
 * Reverse index from a Slack workspace (team_id) to the tenant that
 * registered it. Inbound Slack payloads only carry team_id, never our
 * internal tenantId, so signature verification needs this lookup before it
 * can find the right signing secret in TenantConfig.
 */
export interface SlackWorkspaceLinkRecord {
    teamId: string;
    tenantId: string;
    botUserId: string | null;
}

/** Thrown when a Slack team_id is already linked to a different tenant. */
export class SlackWorkspaceLinkConflictError extends Error {
    constructor(public readonly teamId: string) {
        super(`Slack workspace "${teamId}" is already linked to a different tenant`);
        this.name = 'SlackWorkspaceLinkConflictError';
    }
}

export interface ISlackWorkspaceLinkRepository {
    /**
     * Resolve the tenantId that owns a Slack workspace. Returns null if no
     * tenant has linked this team_id yet.
     */
    findTenantIdByTeamId(teamId: string): Promise<string | null>;

    /**
     * Link a Slack workspace to a tenant (upsert on teamId). Throws if the
     * teamId is already linked to a *different* tenant — a workspace can only
     * ever belong to one tenant.
     */
    upsertLink(params: { teamId: string; tenantId: string; botUserId?: string | null }): Promise<void>;

    /**
     * Look up the current link for a tenant, if any.
     */
    getLinkForTenant(tenantId: string): Promise<SlackWorkspaceLinkRecord | null>;

    /**
     * Drop a tenant's workspace link. Called when the tenant resets its Slack
     * configuration: a link left behind would keep routing inbound team_ids to a
     * tenant that no longer holds a signing secret, so every slash command would
     * fail signature verification instead of being cleanly rejected as unlinked.
     * Returns the number of rows removed (0 when the tenant had no link).
     */
    deleteLinkForTenant(tenantId: string): Promise<number>;
}
