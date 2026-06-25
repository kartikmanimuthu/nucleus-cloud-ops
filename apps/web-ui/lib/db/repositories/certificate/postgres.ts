import { getTenantClient } from '@/lib/db/pg-config';
import type { ICertificateRepository, CertificateRecord, CertificateFilters, CertificatePage } from './interface';

export class CertificatePostgresRepository implements ICertificateRepository {
    async listCertificates(filters: CertificateFilters): Promise<CertificatePage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        if (filters.status) {
            where.status = filters.status;
        }
        if (filters.searchTerm) {
            where.OR = [
                { name: { contains: filters.searchTerm, mode: 'insensitive' } },
                { domainName: { contains: filters.searchTerm, mode: 'insensitive' } },
            ];
        }

        const [certificates, total] = await Promise.all([
            db.certificate.findMany({
                where,
                orderBy: { notAfter: 'asc' },
                skip,
                take: limit,
            }),
            db.certificate.count({ where }),
        ]);

        return {
            certificates: certificates.map(this.toRecord),
            total,
        };
    }

    async getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null> {
        const db = getTenantClient(tenantId);
        const cert = await db.certificate.findUnique({ where: { id: certId, tenantId } });
        return cert ? this.toRecord(cert) : null;
    }

    async createCertificate(
        data: Omit<CertificateRecord, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<CertificateRecord> {
        const db = getTenantClient(data.tenantId);
        const cert = await db.certificate.create({
            data: {
                tenantId: data.tenantId,
                name: data.name,
                domainName: data.domainName,
                status: data.status,
                issuer: data.issuer,
                notBefore: data.notBefore ? new Date(data.notBefore) : null,
                notAfter: new Date(data.notAfter),
                s3BodyKey: data.s3BodyKey,
                s3ChainKey: data.s3ChainKey,
                s3PrivateKeyKey: data.s3PrivateKeyKey,
                associatedAccountIds: data.associatedAccountIds,
                tags: data.tags,
                createdBy: data.createdBy,
            },
        });
        return this.toRecord(cert);
    }

    async deleteCertificate(tenantId: string, certId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificate.delete({ where: { id: certId, tenantId } });
    }

    async updateStatus(
        tenantId: string,
        certId: string,
        status: 'active' | 'expiring' | 'expired'
    ): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificate.update({
            where: { id: certId, tenantId },
            data: { status },
        });
    }

    private toRecord(row: {
        id: string;
        tenantId: string;
        name: string;
        domainName: string;
        status: string;
        issuer: string | null;
        notBefore: Date | null;
        notAfter: Date;
        s3BodyKey: string;
        s3ChainKey: string | null;
        s3PrivateKeyKey: string;
        associatedAccountIds: string[];
        tags: unknown;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    }): CertificateRecord {
        return {
            id: row.id,
            tenantId: row.tenantId,
            name: row.name,
            domainName: row.domainName,
            status: row.status as 'active' | 'expiring' | 'expired',
            issuer: row.issuer,
            notBefore: row.notBefore?.toISOString() ?? null,
            notAfter: row.notAfter.toISOString(),
            s3BodyKey: row.s3BodyKey,
            s3ChainKey: row.s3ChainKey,
            s3PrivateKeyKey: row.s3PrivateKeyKey,
            associatedAccountIds: row.associatedAccountIds,
            tags: row.tags as Record<string, string>,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            createdBy: row.createdBy,
        };
    }
}
