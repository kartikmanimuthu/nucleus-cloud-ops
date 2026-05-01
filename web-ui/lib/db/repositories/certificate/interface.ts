export interface CertificateRecord {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    status: 'active' | 'expiring' | 'expired';
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    associatedAccountIds: string[];
    tags: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}

export interface CertificateFilters {
    tenantId: string;
    status?: 'active' | 'expiring' | 'expired';
    searchTerm?: string;
    page?: number;
    limit?: number;
}

export interface CertificatePage {
    certificates: CertificateRecord[];
    total: number;
}

export interface ICertificateRepository {
    listCertificates(filters: CertificateFilters): Promise<CertificatePage>;
    getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null>;
    createCertificate(
        data: Omit<CertificateRecord, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<CertificateRecord>;
    deleteCertificate(tenantId: string, certId: string): Promise<void>;
    updateStatus(tenantId: string, certId: string, status: 'active' | 'expiring' | 'expired'): Promise<void>;
}
