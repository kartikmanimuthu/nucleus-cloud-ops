'use client';

/**
 * TanStack Query hooks for the Certificate Manager domain.
 *
 * No client service class exists, so the API fetches are inlined in the
 * query/mutation fns (same style as `right-sizing.ts`). Every read parses the
 * `{ success, data }` envelope and throws on failure; every mutation
 * invalidates `queryKeys.certificates.all` so lists, detail, and the per-cert
 * sub-keys (versions / accounts / executions / content) all refresh.
 *
 * Toasts are NOT fired here — call sites fire `toast.*` from `sonner`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';

// ---------------------------------------------------------------------------
// Response shapes (mirror the /api/certificates/* route contracts)
// ---------------------------------------------------------------------------

export type CertificateStatus = 'active' | 'expiring' | 'expired' | 'no_material';

export interface CertificateRow {
    id: string;
    name: string;
    domainName: string;
    status: CertificateStatus;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string | null;
    activeVersionId: string | null;
    associatedAccountIds: string[];
    associatedAccountNames: string[];
    createdAt?: string;
    updatedAt?: string;
}

export interface VersionRecord {
    id: string;
    version: number;
    isActive: boolean;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    fingerprint: string | null;
    serialNumber?: string | null;
    status: string;
    uploadedAt: string;
    uploadedBy: string;
}

export interface CertificateDetail {
    id: string;
    name: string;
    domainName: string;
    status: CertificateStatus;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string | null;
    activeVersionId: string | null;
    associatedAccountIds: string[];
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    activeVersion: VersionRecord | null;
}

export interface CertificateContent {
    body: string;
    chain?: string | null;
    privateKey: string;
}

export interface CertificateAccountDeployment {
    region: string;
    acmArn: string | null;
    acmNotAfter: string | null;
    acmStatus: string | null;
    linkState: string;
    inUseByCount: number;
}

export interface CertificateAccount {
    accountId: string;
    accountName: string;
    active: boolean;
    connectionStatus: string;
    regions: string[];
    acmNotAfter: string | null;
    linkState: string;
    lastScannedAt: string | null;
    resourceCount: number;
    deployments: CertificateAccountDeployment[];
}

export interface ExecutionRecord {
    id: string;
    executionId?: string;
    operation: string;
    versionId?: string | null;
    accountId: string | null;
    region: string | null;
    status: string;
    acmArn?: string | null;
    message: string | null;
    details?: unknown;
    startedAt: string;
    finishedAt: string | null;
    duration: number | null;
    triggeredBy: string;
}

export interface AssociatedResource {
    arn: string;
    type: string;
    service: string;
}

export interface AcmCertificateDetail {
    arn: string;
    status: string;
    domainName: string;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string | null;
    serial: string | null;
    signatureAlgorithm?: string | null;
    type: string | null;
    importedAt: string | null;
    inUseBy: AssociatedResource[];
}

export interface CertificateAccountDetailData {
    certificate: AcmCertificateDetail;
    account: { accountId: string; name: string };
}

export interface DiscoverResult {
    status: 'success' | 'partial';
    matched: number;
    errored: number;
    skipped: number;
    targets: number;
    accountsScanned: number;
    results?: unknown[];
}

export interface ReimportPerRegion {
    region: string;
    arn?: string;
    ok: boolean;
    error?: string;
}

export interface ReimportResult {
    accountId: string;
    version: number;
    perRegion: ReimportPerRegion[];
    status: 'success' | 'partial' | 'failed';
}

export interface DeployResult {
    certificateArn: string;
    accountId: string;
    region: string;
}

export interface CertificateFilters {
    status?: CertificateStatus | '';
    search?: string;
    limit?: number;
    page?: number;
}

export interface UploadCertificateInput {
    name: string;
    domainName: string;
    body: string;
    chain?: string;
    privateKey: string;
}

export interface UploadVersionInput {
    certId: string;
    body: string;
    chain?: string;
    privateKey: string;
    activate?: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useCertificates(filters?: CertificateFilters) {
    return useQuery({
        queryKey: queryKeys.certificates.list(filters),
        queryFn: async (): Promise<{ data: CertificateRow[]; total: number }> => {
            const params = new URLSearchParams();
            if (filters?.status) params.set('status', filters.status);
            if (filters?.search?.trim()) params.set('search', filters.search.trim());
            params.set('limit', String(filters?.limit ?? 100));
            params.set('page', String(filters?.page ?? 1));

            const res = await fetch(`/api/certificates?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load certificates');
            }
            return { data: json.data as CertificateRow[], total: json.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

export function useCertificate(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.certificates.detail(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<CertificateDetail> => {
            const res = await fetch(`/api/certificates/${id}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load certificate');
            }
            return json.data as CertificateDetail;
        },
    });
}

export function useCertificateContent(id: string | undefined, versionId?: string) {
    return useQuery({
        queryKey: queryKeys.certificates.content(id ?? '', versionId),
        enabled: !!id,
        queryFn: async (): Promise<CertificateContent> => {
            const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
            const res = await fetch(`/api/certificates/${id}/content${qs}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load certificate material');
            }
            return json.data as CertificateContent;
        },
    });
}

export function useCertificateVersions(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.certificates.versions(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<VersionRecord[]> => {
            const res = await fetch(`/api/certificates/${id}/versions`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load versions');
            }
            return json.data as VersionRecord[];
        },
    });
}

export function useCertificateAccounts(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.certificates.accounts(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<CertificateAccount[]> => {
            const res = await fetch(`/api/certificates/${id}/accounts`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load accounts');
            }
            return (json.data?.accounts ?? []) as CertificateAccount[];
        },
    });
}

export function useCertificateAccountDetail(
    id: string | undefined,
    accountId: string | undefined,
) {
    return useQuery({
        queryKey: queryKeys.certificates.accountDetail(id ?? '', accountId ?? ''),
        enabled: !!id && !!accountId,
        queryFn: async (): Promise<CertificateAccountDetailData> => {
            const res = await fetch(`/api/certificates/${id}/accounts/${accountId}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Certificate or account not found');
            }
            return json.data as CertificateAccountDetailData;
        },
    });
}

export function useCertificateExecutions(id: string | undefined, limit = 100) {
    return useQuery({
        queryKey: queryKeys.certificates.executions(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<ExecutionRecord[]> => {
            const res = await fetch(`/api/certificates/${id}/executions?limit=${limit}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load execution history');
            }
            return json.data as ExecutionRecord[];
        },
    });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useUploadCertificate() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (input: UploadCertificateInput): Promise<CertificateRow> => {
            const res = await fetch('/api/certificates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to upload certificate');
            }
            return json.data as CertificateRow;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useDeleteCertificate() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            const res = await fetch(`/api/certificates/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to delete certificate');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useDiscoverCertificate() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (certId: string): Promise<DiscoverResult> => {
            const res = await fetch(`/api/certificates/${certId}/discover`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Discovery failed');
            }
            return json.data as DiscoverResult;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useDeployCertificate() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (vars: {
            certId: string;
            accountId: string;
            region?: string;
            force?: boolean;
        }): Promise<DeployResult> => {
            const res = await fetch(`/api/certificates/${vars.certId}/deploy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accountId: vars.accountId,
                    region: vars.region,
                    force: vars.force,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to deploy certificate');
            }
            return json.data as DeployResult;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

/**
 * Reimport returns 200 even for `partial`/`failed` AWS outcomes (the envelope
 * carries `success` + per-region detail). We throw only on transport/HTTP
 * errors; the caller inspects `data.status` to decide success vs. warning.
 */
export function useReimportCertificate() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (vars: {
            certId: string;
            accountId: string;
        }): Promise<{ success: boolean; data: ReimportResult; error?: string }> => {
            const res = await fetch(`/api/certificates/${vars.certId}/reimport`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId: vars.accountId }),
            });
            const json = await res.json();
            if (res.status >= 500) {
                throw new Error(json.error || 'Reimport failed');
            }
            if (!json.data) {
                throw new Error(json.error || 'Reimport failed');
            }
            return json as { success: boolean; data: ReimportResult; error?: string };
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useUploadVersion() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (input: UploadVersionInput): Promise<VersionRecord> => {
            const { certId, ...payload } = input;
            const res = await fetch(`/api/certificates/${certId}/versions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to upload version');
            }
            return json.data as VersionRecord;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useActivateVersion() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (vars: { certId: string; versionId: string }): Promise<void> => {
            const res = await fetch(
                `/api/certificates/${vars.certId}/versions/${vars.versionId}/activate`,
                { method: 'POST' },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to activate version');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}

export function useDeleteVersion() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (vars: { certId: string; versionId: string }): Promise<void> => {
            const res = await fetch(
                `/api/certificates/${vars.certId}/versions/${vars.versionId}`,
                { method: 'DELETE' },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to delete version');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.certificates.all });
        },
    });
}
