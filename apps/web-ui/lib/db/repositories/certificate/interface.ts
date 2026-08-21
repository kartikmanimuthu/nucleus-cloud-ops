import type { PrismaRowFilter } from '@/lib/db/pg-config';

export type CertificateStatus = 'active' | 'expiring' | 'expired' | 'no_material';
export type VersionStatus = 'active' | 'expiring' | 'expired';
export type LinkState = 'discovered' | 'deployed' | 'missing' | 'error';
export type ExecutionOperation = 'discover' | 'deploy' | 'reimport';
export type ExecutionStatus = 'running' | 'success' | 'failed' | 'partial';

export interface CertificateRecord {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    activeVersionId: string | null;
    status: CertificateStatus;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}

export interface CertificateVersionRecord {
    id: string;
    tenantId: string;
    certificateId: string;
    version: number;
    isActive: boolean;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    fingerprint: string | null;
    serialNumber: string | null;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    status: VersionStatus;
    uploadedAt: string;
    uploadedBy: string;
}

export interface CertificateDeploymentRecord {
    id: string;
    tenantId: string;
    certificateId: string;
    accountId: string;
    region: string;
    acmArn: string | null;
    acmDomainName: string | null;
    acmNotAfter: string | null;
    acmStatus: string | null;
    deployedVersionId: string | null;
    linkState: LinkState;
    inUseByCount: number;
    lastScannedAt: string | null;
    lastDeployedAt: string | null;
}

export interface CertificateExecutionRecord {
    id: string;
    tenantId: string;
    certificateId: string;
    executionId: string;
    operation: ExecutionOperation;
    versionId: string | null;
    accountId: string | null;
    region: string | null;
    status: ExecutionStatus;
    acmArn: string | null;
    message: string | null;
    details: unknown;
    startedAt: string;
    finishedAt: string | null;
    duration: number | null;
    triggeredBy: string;
    expiresAt: string;
}

export interface CertificateFilters {
    tenantId: string;
    status?: CertificateStatus;
    searchTerm?: string;
    page?: number;
    limit?: number;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface CertificatePage {
    certificates: CertificateRecord[];
    total: number;
}

export interface CreateCertificateInput {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    createdBy: string;
    // Initial (v1, active) version material:
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    fingerprint: string | null;
    serialNumber: string | null;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    status: VersionStatus;
}

export interface CreateVersionInput {
    tenantId: string;
    certificateId: string;
    version: number;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    fingerprint: string | null;
    serialNumber: string | null;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    status: VersionStatus;
    uploadedBy: string;
}

export interface UpsertDeploymentInput {
    tenantId: string;
    certificateId: string;
    accountId: string;
    region: string;
    acmArn?: string | null;
    acmDomainName?: string | null;
    acmNotAfter?: string | null;
    acmStatus?: string | null;
    deployedVersionId?: string | null;
    linkState: LinkState;
    inUseByCount?: number;
    lastScannedAt?: string | null;
    lastDeployedAt?: string | null;
}

export interface CreateExecutionInput {
    tenantId: string;
    certificateId: string;
    executionId: string;
    operation: ExecutionOperation;
    versionId?: string | null;
    accountId?: string | null;
    region?: string | null;
    status: ExecutionStatus;
    acmArn?: string | null;
    message?: string | null;
    details?: unknown;
    triggeredBy: string;
    expiresAt: string;
}

export interface FinishExecutionInput {
    status: ExecutionStatus;
    acmArn?: string | null;
    message?: string | null;
    details?: unknown;
    duration?: number | null;
}

export interface ICertificateRepository {
    // --- certificates ---
    listCertificates(filters: CertificateFilters): Promise<CertificatePage>;
    getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null>;
    createWithInitialVersion(
        input: CreateCertificateInput
    ): Promise<{ certificate: CertificateRecord; version: CertificateVersionRecord }>;
    deleteCertificate(tenantId: string, certId: string): Promise<void>;
    updateCachedStatus(tenantId: string, certId: string, status: CertificateStatus): Promise<void>;

    // --- versions ---
    listVersions(tenantId: string, certId: string): Promise<CertificateVersionRecord[]>;
    getVersion(tenantId: string, certId: string, versionId: string): Promise<CertificateVersionRecord | null>;
    getActiveVersion(tenantId: string, certId: string): Promise<CertificateVersionRecord | null>;
    findVersionByFingerprint(
        tenantId: string,
        certId: string,
        fingerprint: string
    ): Promise<CertificateVersionRecord | null>;
    nextVersionNumber(tenantId: string, certId: string): Promise<number>;
    createVersion(input: CreateVersionInput): Promise<CertificateVersionRecord>;
    deleteVersion(tenantId: string, certId: string, versionId: string): Promise<void>;
    activateVersion(tenantId: string, certId: string, versionId: string): Promise<void>;
    setVersionFingerprint(
        tenantId: string,
        versionId: string,
        fingerprint: string,
        serialNumber: string | null
    ): Promise<void>;

    // --- deployments ---
    listDeployments(tenantId: string, certId: string): Promise<CertificateDeploymentRecord[]>;
    getDeployment(
        tenantId: string,
        certId: string,
        accountId: string,
        region: string
    ): Promise<CertificateDeploymentRecord | null>;
    findDeployedInAccount(
        tenantId: string,
        certId: string,
        accountId: string
    ): Promise<CertificateDeploymentRecord | null>;
    upsertDeployment(input: UpsertDeploymentInput): Promise<CertificateDeploymentRecord>;
    deleteUnknownRegionDeployments(tenantId: string, certId: string, accountId: string): Promise<void>;

    // --- executions ---
    listExecutions(tenantId: string, certId: string, limit?: number): Promise<CertificateExecutionRecord[]>;
    createExecution(input: CreateExecutionInput): Promise<CertificateExecutionRecord>;
    finishExecution(
        tenantId: string,
        executionId: string,
        fields: FinishExecutionInput
    ): Promise<void>;
}
