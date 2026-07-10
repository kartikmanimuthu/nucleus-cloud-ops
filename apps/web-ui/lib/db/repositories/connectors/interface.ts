/**
 * IConnectorRepository
 *
 * Contract for connector OAuth persistence — tenant OAuth app credentials
 * (`connector_apps`) and OAuth grants (`connector_connections`).
 * Multi-tenant safety: every method is scoped by tenantId.
 */
export type ConnectorProvider = 'jira' | 'slack' | 'google';

export interface ConnectorAppRecord {
    id: string;
    tenantId: string;
    provider: string;
    clientId: string;
    clientSecretEnc: string;
    signingSecretEnc: string | null;
    botTokenEnc: string | null;
    botAccountLabel: string | null;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface ConnectorConnectionRecord {
    id: string;
    tenantId: string;
    provider: string;
    accountLabel: string;
    externalAccountId: string;
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    expiresAt: Date | null;
    scopes: string[];
    tokenType: string;
    metadata: unknown;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface UpsertAppInput {
    provider: ConnectorProvider;
    clientId?: string;
    clientSecretEnc?: string;
    signingSecretEnc?: string;
    botTokenEnc?: string;
    botAccountLabel?: string;
}

export interface UpsertConnectionInput {
    provider: ConnectorProvider;
    accountLabel: string;
    externalAccountId: string;
    accessTokenEnc: string;
    refreshTokenEnc?: string;
    expiresAt?: Date | null;
    scopes: string[];
    tokenType: 'user' | 'bot';
    metadata: Record<string, unknown>;
}

export interface ConnectionTokenPatch {
    accessTokenEnc: string;
    refreshTokenEnc?: string;
    expiresAt?: Date | null;
    status?: string;
}

export interface IConnectorRepository {
    getApp(provider: ConnectorProvider, tenantId: string): Promise<ConnectorAppRecord | null>;
    upsertApp(input: UpsertAppInput, tenantId: string, updatedBy: string): Promise<void>;
    deleteApp(provider: ConnectorProvider, tenantId: string): Promise<void>;
    listConnections(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord[]>;
    getActiveConnection(provider: ConnectorProvider, tenantId: string): Promise<ConnectorConnectionRecord | null>;
    upsertConnection(input: UpsertConnectionInput, tenantId: string, createdBy: string): Promise<ConnectorConnectionRecord>;
    updateConnectionTokens(id: string, tenantId: string, patch: ConnectionTokenPatch): Promise<void>;
    deleteConnection(id: string, tenantId: string): Promise<void>;
}
