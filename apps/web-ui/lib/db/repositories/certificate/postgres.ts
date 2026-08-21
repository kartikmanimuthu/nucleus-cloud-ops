import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type {
    ICertificateRepository,
    CertificateRecord,
    CertificateVersionRecord,
    CertificateDeploymentRecord,
    CertificateExecutionRecord,
    CertificateFilters,
    CertificatePage,
    CertificateStatus,
    VersionStatus,
    LinkState,
    ExecutionOperation,
    ExecutionStatus,
    CreateCertificateInput,
    CreateVersionInput,
    UpsertDeploymentInput,
    CreateExecutionInput,
    FinishExecutionInput,
} from './interface';

type CertRow = {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    activeVersionId: string | null;
    status: string;
    issuer: string | null;
    notBefore: Date | null;
    notAfter: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
};

type VersionRow = {
    id: string;
    tenantId: string;
    certificateId: string;
    version: number;
    isActive: boolean;
    issuer: string | null;
    notBefore: Date | null;
    notAfter: Date;
    fingerprint: string | null;
    serialNumber: string | null;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    status: string;
    uploadedAt: Date;
    uploadedBy: string;
};

type DeploymentRow = {
    id: string;
    tenantId: string;
    certificateId: string;
    accountId: string;
    region: string;
    acmArn: string | null;
    acmDomainName: string | null;
    acmNotAfter: Date | null;
    acmStatus: string | null;
    deployedVersionId: string | null;
    linkState: string;
    inUseByCount: number;
    lastScannedAt: Date | null;
    lastDeployedAt: Date | null;
};

type ExecutionRow = {
    id: string;
    tenantId: string;
    certificateId: string;
    executionId: string;
    operation: string;
    versionId: string | null;
    accountId: string | null;
    region: string | null;
    status: string;
    acmArn: string | null;
    message: string | null;
    details: unknown;
    startedAt: Date;
    finishedAt: Date | null;
    duration: number | null;
    triggeredBy: string;
    expiresAt: Date;
};

export class CertificatePostgresRepository implements ICertificateRepository {
    // ---------------------------------------------------------------- certificates

    async listCertificates(filters: CertificateFilters): Promise<CertificatePage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        if (filters.status) where.status = filters.status;
        if (filters.searchTerm) {
            where.OR = [
                { name: { contains: filters.searchTerm, mode: 'insensitive' } },
                { domainName: { contains: filters.searchTerm, mode: 'insensitive' } },
            ];
        }

        // Gate 3: intersect the caller's readable rows. andWhere() nests under
        // AND so the `OR` search clause above survives, and tenantId is still
        // injected on top by the tenant client.
        const scoped = andWhere(where, filters.rowFilter);

        const [certificates, total] = await Promise.all([
            db.certificate.findMany({
                where: scoped,
                orderBy: [{ notAfter: { sort: 'asc', nulls: 'last' } }],
                skip,
                take: limit,
            }),
            db.certificate.count({ where: scoped }),
        ]);

        return { certificates: certificates.map(toCertRecord), total };
    }

    async getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null> {
        const db = getTenantClient(tenantId);
        const cert = await db.certificate.findUnique({ where: { id: certId, tenantId } });
        return cert ? toCertRecord(cert as CertRow) : null;
    }

    async createWithInitialVersion(
        input: CreateCertificateInput
    ): Promise<{ certificate: CertificateRecord; version: CertificateVersionRecord }> {
        const db = getTenantClient(input.tenantId);
        return db.$transaction(async (tx) => {
            const cert = (await tx.certificate.create({
                data: {
                    id: input.id,
                    tenantId: input.tenantId,
                    name: input.name,
                    domainName: input.domainName,
                    status: input.status,
                    issuer: input.issuer,
                    notBefore: input.notBefore ? new Date(input.notBefore) : null,
                    notAfter: new Date(input.notAfter),
                    createdBy: input.createdBy,
                },
            })) as CertRow;

            const version = (await tx.certificateVersion.create({
                data: {
                    tenantId: input.tenantId,
                    certificateId: cert.id,
                    version: 1,
                    isActive: true,
                    issuer: input.issuer,
                    notBefore: input.notBefore ? new Date(input.notBefore) : null,
                    notAfter: new Date(input.notAfter),
                    fingerprint: input.fingerprint,
                    serialNumber: input.serialNumber,
                    s3BodyKey: input.s3BodyKey,
                    s3ChainKey: input.s3ChainKey,
                    s3PrivateKeyKey: input.s3PrivateKeyKey,
                    status: input.status,
                    uploadedBy: input.createdBy,
                },
            })) as VersionRow;

            const updated = (await tx.certificate.update({
                where: { id: cert.id, tenantId: input.tenantId },
                data: { activeVersionId: version.id },
            })) as CertRow;

            return { certificate: toCertRecord(updated), version: toVersionRecord(version) };
        });
    }

    async deleteCertificate(tenantId: string, certId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.$transaction(async (tx) => {
            await tx.certificateExecution.deleteMany({ where: { certificateId: certId, tenantId } });
            await tx.certificateDeployment.deleteMany({ where: { certificateId: certId, tenantId } });
            // Detach active pointer before removing versions (FK-free, but keeps state clean).
            await tx.certificate.update({
                where: { id: certId, tenantId },
                data: { activeVersionId: null },
            });
            await tx.certificateVersion.deleteMany({ where: { certificateId: certId, tenantId } });
            await tx.certificate.delete({ where: { id: certId, tenantId } });
        });
    }

    async updateCachedStatus(tenantId: string, certId: string, status: CertificateStatus): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificate.update({ where: { id: certId, tenantId }, data: { status } });
    }

    // -------------------------------------------------------------------- versions

    async listVersions(tenantId: string, certId: string): Promise<CertificateVersionRecord[]> {
        const db = getTenantClient(tenantId);
        const rows = await db.certificateVersion.findMany({
            where: { certificateId: certId, tenantId },
            orderBy: { version: 'desc' },
        });
        return (rows as VersionRow[]).map(toVersionRecord);
    }

    async getVersion(
        tenantId: string,
        certId: string,
        versionId: string
    ): Promise<CertificateVersionRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.certificateVersion.findFirst({
            where: { id: versionId, certificateId: certId, tenantId },
        });
        return row ? toVersionRecord(row as VersionRow) : null;
    }

    async getActiveVersion(tenantId: string, certId: string): Promise<CertificateVersionRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.certificateVersion.findFirst({
            where: { certificateId: certId, tenantId, isActive: true },
        });
        return row ? toVersionRecord(row as VersionRow) : null;
    }

    async findVersionByFingerprint(
        tenantId: string,
        certId: string,
        fingerprint: string
    ): Promise<CertificateVersionRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.certificateVersion.findFirst({
            where: { certificateId: certId, tenantId, fingerprint },
        });
        return row ? toVersionRecord(row as VersionRow) : null;
    }

    async nextVersionNumber(tenantId: string, certId: string): Promise<number> {
        const db = getTenantClient(tenantId);
        const top = await db.certificateVersion.findFirst({
            where: { certificateId: certId, tenantId },
            orderBy: { version: 'desc' },
            select: { version: true },
        });
        return (top?.version ?? 0) + 1;
    }

    async createVersion(input: CreateVersionInput): Promise<CertificateVersionRecord> {
        const db = getTenantClient(input.tenantId);
        const row = (await db.certificateVersion.create({
            data: {
                tenantId: input.tenantId,
                certificateId: input.certificateId,
                version: input.version,
                isActive: false,
                issuer: input.issuer,
                notBefore: input.notBefore ? new Date(input.notBefore) : null,
                notAfter: new Date(input.notAfter),
                fingerprint: input.fingerprint,
                serialNumber: input.serialNumber,
                s3BodyKey: input.s3BodyKey,
                s3ChainKey: input.s3ChainKey,
                s3PrivateKeyKey: input.s3PrivateKeyKey,
                status: input.status,
                uploadedBy: input.uploadedBy,
            },
        })) as VersionRow;
        return toVersionRecord(row);
    }

    async deleteVersion(tenantId: string, certId: string, versionId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificateVersion.deleteMany({
            where: { id: versionId, certificateId: certId, tenantId },
        });
    }

    async activateVersion(tenantId: string, certId: string, versionId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.$transaction(async (tx) => {
            // Clear active first so the partial unique index never sees two actives.
            await tx.certificateVersion.updateMany({
                where: { certificateId: certId, tenantId },
                data: { isActive: false },
            });
            const target = (await tx.certificateVersion.update({
                where: { id: versionId, tenantId },
                data: { isActive: true },
            })) as VersionRow;
            await tx.certificate.update({
                where: { id: certId, tenantId },
                data: {
                    activeVersionId: target.id,
                    status: target.status,
                    notAfter: target.notAfter,
                    notBefore: target.notBefore,
                    issuer: target.issuer,
                },
            });
        });
    }

    async setVersionFingerprint(
        tenantId: string,
        versionId: string,
        fingerprint: string,
        serialNumber: string | null
    ): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificateVersion.update({
            where: { id: versionId, tenantId },
            data: { fingerprint, serialNumber },
        });
    }

    // ----------------------------------------------------------------- deployments

    async listDeployments(tenantId: string, certId: string): Promise<CertificateDeploymentRecord[]> {
        const db = getTenantClient(tenantId);
        const rows = await db.certificateDeployment.findMany({
            where: { certificateId: certId, tenantId },
            orderBy: [{ accountId: 'asc' }, { region: 'asc' }],
        });
        return (rows as DeploymentRow[]).map(toDeploymentRecord);
    }

    async getDeployment(
        tenantId: string,
        certId: string,
        accountId: string,
        region: string
    ): Promise<CertificateDeploymentRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.certificateDeployment.findFirst({
            where: { certificateId: certId, tenantId, accountId, region },
        });
        return row ? toDeploymentRecord(row as DeploymentRow) : null;
    }

    async findDeployedInAccount(
        tenantId: string,
        certId: string,
        accountId: string
    ): Promise<CertificateDeploymentRecord | null> {
        const db = getTenantClient(tenantId);
        const row = await db.certificateDeployment.findFirst({
            where: { certificateId: certId, tenantId, accountId, acmArn: { not: null } },
        });
        return row ? toDeploymentRecord(row as DeploymentRow) : null;
    }

    async upsertDeployment(input: UpsertDeploymentInput): Promise<CertificateDeploymentRecord> {
        const db = getTenantClient(input.tenantId);
        const existing = await db.certificateDeployment.findFirst({
            where: {
                certificateId: input.certificateId,
                tenantId: input.tenantId,
                accountId: input.accountId,
                region: input.region,
            },
            select: { id: true },
        });

        const data = {
            acmArn: input.acmArn ?? null,
            acmDomainName: input.acmDomainName ?? null,
            acmNotAfter: input.acmNotAfter ? new Date(input.acmNotAfter) : null,
            acmStatus: input.acmStatus ?? null,
            deployedVersionId: input.deployedVersionId ?? null,
            linkState: input.linkState,
            inUseByCount: input.inUseByCount ?? 0,
            lastScannedAt: input.lastScannedAt ? new Date(input.lastScannedAt) : null,
            lastDeployedAt: input.lastDeployedAt ? new Date(input.lastDeployedAt) : null,
        };

        let row: DeploymentRow;
        if (existing) {
            row = (await db.certificateDeployment.update({
                where: { id: existing.id, tenantId: input.tenantId },
                data,
            })) as DeploymentRow;
        } else {
            row = (await db.certificateDeployment.create({
                data: {
                    tenantId: input.tenantId,
                    certificateId: input.certificateId,
                    accountId: input.accountId,
                    region: input.region,
                    ...data,
                },
            })) as DeploymentRow;
        }
        return toDeploymentRecord(row);
    }

    async deleteUnknownRegionDeployments(
        tenantId: string,
        certId: string,
        accountId: string
    ): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificateDeployment.deleteMany({
            where: { certificateId: certId, tenantId, accountId, region: 'unknown' },
        });
    }

    // ------------------------------------------------------------------ executions

    async listExecutions(
        tenantId: string,
        certId: string,
        limit = 50
    ): Promise<CertificateExecutionRecord[]> {
        const db = getTenantClient(tenantId);
        const rows = await db.certificateExecution.findMany({
            where: { certificateId: certId, tenantId },
            orderBy: { startedAt: 'desc' },
            take: limit,
        });
        return (rows as ExecutionRow[]).map(toExecutionRecord);
    }

    async createExecution(input: CreateExecutionInput): Promise<CertificateExecutionRecord> {
        const db = getTenantClient(input.tenantId);
        const row = (await db.certificateExecution.create({
            data: {
                tenantId: input.tenantId,
                certificateId: input.certificateId,
                executionId: input.executionId,
                operation: input.operation,
                versionId: input.versionId ?? null,
                accountId: input.accountId ?? null,
                region: input.region ?? null,
                status: input.status,
                acmArn: input.acmArn ?? null,
                message: input.message ?? null,
                details: (input.details ?? undefined) as never,
                triggeredBy: input.triggeredBy,
                expiresAt: new Date(input.expiresAt),
            },
        })) as ExecutionRow;
        return toExecutionRecord(row);
    }

    async finishExecution(
        tenantId: string,
        executionId: string,
        fields: FinishExecutionInput
    ): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificateExecution.updateMany({
            where: { executionId, tenantId },
            data: {
                status: fields.status,
                acmArn: fields.acmArn ?? undefined,
                message: fields.message ?? undefined,
                details: (fields.details ?? undefined) as never,
                duration: fields.duration ?? undefined,
                finishedAt: new Date(),
            },
        });
    }
}

// ------------------------------------------------------------------------ mappers

function toCertRecord(row: CertRow): CertificateRecord {
    return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        domainName: row.domainName,
        activeVersionId: row.activeVersionId,
        status: row.status as CertificateStatus,
        issuer: row.issuer,
        notBefore: row.notBefore?.toISOString() ?? null,
        notAfter: row.notAfter?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        createdBy: row.createdBy,
    };
}

function toVersionRecord(row: VersionRow): CertificateVersionRecord {
    return {
        id: row.id,
        tenantId: row.tenantId,
        certificateId: row.certificateId,
        version: row.version,
        isActive: row.isActive,
        issuer: row.issuer,
        notBefore: row.notBefore?.toISOString() ?? null,
        notAfter: row.notAfter.toISOString(),
        fingerprint: row.fingerprint,
        serialNumber: row.serialNumber,
        s3BodyKey: row.s3BodyKey,
        s3ChainKey: row.s3ChainKey,
        s3PrivateKeyKey: row.s3PrivateKeyKey,
        status: row.status as VersionStatus,
        uploadedAt: row.uploadedAt.toISOString(),
        uploadedBy: row.uploadedBy,
    };
}

function toDeploymentRecord(row: DeploymentRow): CertificateDeploymentRecord {
    return {
        id: row.id,
        tenantId: row.tenantId,
        certificateId: row.certificateId,
        accountId: row.accountId,
        region: row.region,
        acmArn: row.acmArn,
        acmDomainName: row.acmDomainName,
        acmNotAfter: row.acmNotAfter?.toISOString() ?? null,
        acmStatus: row.acmStatus,
        deployedVersionId: row.deployedVersionId,
        linkState: row.linkState as LinkState,
        inUseByCount: row.inUseByCount,
        lastScannedAt: row.lastScannedAt?.toISOString() ?? null,
        lastDeployedAt: row.lastDeployedAt?.toISOString() ?? null,
    };
}

function toExecutionRecord(row: ExecutionRow): CertificateExecutionRecord {
    return {
        id: row.id,
        tenantId: row.tenantId,
        certificateId: row.certificateId,
        executionId: row.executionId,
        operation: row.operation as ExecutionOperation,
        versionId: row.versionId,
        accountId: row.accountId,
        region: row.region,
        status: row.status as ExecutionStatus,
        acmArn: row.acmArn,
        message: row.message,
        details: row.details,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        duration: row.duration,
        triggeredBy: row.triggeredBy,
        expiresAt: row.expiresAt.toISOString(),
    };
}
