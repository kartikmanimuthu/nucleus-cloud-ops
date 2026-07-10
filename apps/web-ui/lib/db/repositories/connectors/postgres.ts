/**
 * ConnectorPostgresRepository
 *
 * PostgreSQL implementation of IConnectorRepository. Reads/writes
 * `connector_apps` + `connector_connections`. All access via getTenantClient,
 * which auto-scopes by tenantId (see lib/db/pg-config.ts).
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type {
    IConnectorRepository, ConnectorProvider, ConnectorAppRecord,
    ConnectorConnectionRecord, UpsertAppInput, UpsertConnectionInput, ConnectionTokenPatch,
} from './interface';

class ConnectorPostgresRepository implements IConnectorRepository {
    async getApp(provider: ConnectorProvider, tenantId: string): Promise<ConnectorAppRecord | null> {
        const db = getTenantClient(tenantId);
        return (await db.connectorApp.findFirst({ where: { tenantId, provider } })) as ConnectorAppRecord | null;
    }

    async upsertApp(input: UpsertAppInput, tenantId: string, updatedBy: string): Promise<void> {
        const db = getTenantClient(tenantId);
        const update: Record<string, unknown> = { updatedBy };
        for (const k of ['clientId', 'clientSecretEnc', 'signingSecretEnc', 'botTokenEnc', 'botAccountLabel'] as const) {
            if (input[k] !== undefined) update[k] = input[k];
        }
        await db.connectorApp.upsert({
            where: { tenantId_provider: { tenantId, provider: input.provider } },
            update,
            create: {
                tenantId,
                provider: input.provider,
                clientId: input.clientId ?? '',
                clientSecretEnc: input.clientSecretEnc ?? '',
                signingSecretEnc: input.signingSecretEnc ?? null,
                botTokenEnc: input.botTokenEnc ?? null,
                botAccountLabel: input.botAccountLabel ?? null,
                createdBy: updatedBy,
            },
        });
    }

    async deleteApp(provider: ConnectorProvider, tenantId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorApp.deleteMany({ where: { tenantId, provider } });
    }

    async listConnections(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord[]> {
        const db = getTenantClient(tenantId);
        return (await db.connectorConnection.findMany({
            where: { tenantId, provider },
            orderBy: { updatedAt: 'desc' },
        })) as ConnectorConnectionRecord[];
    }

    async getActiveConnection(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord | null> {
        const db = getTenantClient(tenantId);
        return (await db.connectorConnection.findFirst({
            where: { tenantId, provider, status: 'active' },
            orderBy: { updatedAt: 'desc' },
        })) as ConnectorConnectionRecord | null;
    }

    async upsertConnection(input: UpsertConnectionInput, tenantId: string, createdBy: string): Promise<ConnectorConnectionRecord> {
        const db = getTenantClient(tenantId);
        const existing = await db.connectorConnection.findFirst({
            where: { tenantId, provider: input.provider, externalAccountId: input.externalAccountId },
        });
        if (existing) {
            await db.connectorConnection.updateMany({
                where: { id: existing.id, tenantId },
                data: {
                    accountLabel: input.accountLabel,
                    accessTokenEnc: input.accessTokenEnc,
                    refreshTokenEnc: input.refreshTokenEnc ?? existing.refreshTokenEnc,
                    expiresAt: input.expiresAt ?? null,
                    scopes: input.scopes,
                    tokenType: input.tokenType,
                    metadata: input.metadata as object,
                    status: 'active',
                },
            });
            return (await db.connectorConnection.findFirst({ where: { id: existing.id, tenantId } })) as ConnectorConnectionRecord;
        }
        return (await db.connectorConnection.create({
            data: {
                tenantId,
                provider: input.provider,
                accountLabel: input.accountLabel,
                externalAccountId: input.externalAccountId,
                accessTokenEnc: input.accessTokenEnc,
                refreshTokenEnc: input.refreshTokenEnc ?? null,
                expiresAt: input.expiresAt ?? null,
                scopes: input.scopes,
                tokenType: input.tokenType,
                metadata: input.metadata as object,
                createdBy,
            },
        })) as ConnectorConnectionRecord;
    }

    async updateConnectionTokens(id: string, tenantId: string, patch: ConnectionTokenPatch): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorConnection.updateMany({
            where: { id, tenantId },
            data: {
                accessTokenEnc: patch.accessTokenEnc,
                ...(patch.refreshTokenEnc !== undefined ? { refreshTokenEnc: patch.refreshTokenEnc } : {}),
                ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
            },
        });
    }

    async deleteConnection(id: string, tenantId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.connectorConnection.deleteMany({ where: { id, tenantId } });
    }
}

let instance: ConnectorPostgresRepository | null = null;
export function getConnectorRepository(): IConnectorRepository {
    if (!instance) instance = new ConnectorPostgresRepository();
    return instance;
}
