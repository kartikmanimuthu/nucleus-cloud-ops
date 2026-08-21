import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { authorize } from '@/lib/rbac/authorize';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { AuditService } from '@/lib/audit-service';
import { computeExpiryStatus, parseCertificatePem } from '@/lib/certificate-utils';
import { parseCertificate, validateKeyPair } from '@/lib/certificate-crypto';
import { putVersionMaterial, versionS3Prefix } from '@/lib/certificate-material';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const repo = getCertificateRepository();
        const result = await repo.listCertificates({
            tenantId,
            status: searchParams.get('status') as
                | 'active'
                | 'expiring'
                | 'expired'
                | 'no_material'
                | undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
            // Gate 3 — which certificates, not just whether. See lib/rbac/row-filter.ts.
            rowFilter: await getReadRowFilter('Certificate'),
        });

        // Account linkage now comes from CertificateDeployment (live, ACM-discovered),
        // not the legacy associatedAccountIds / inventory correlation.
        const db = getTenantClient(tenantId);
        const certIds = result.certificates.map(c => c.id);
        const deployments = certIds.length
            ? await db.certificateDeployment.findMany({
                  where: { tenantId, certificateId: { in: certIds } },
                  select: { certificateId: true, accountId: true },
              })
            : [];

        const accountIdsByCert = new Map<string, Set<string>>();
        const allAccountIds = new Set<string>();
        for (const d of deployments) {
            if (!accountIdsByCert.has(d.certificateId)) accountIdsByCert.set(d.certificateId, new Set());
            accountIdsByCert.get(d.certificateId)!.add(d.accountId);
            allAccountIds.add(d.accountId);
        }

        const accountNameMap: Record<string, string> = {};
        if (allAccountIds.size > 0) {
            try {
                const accounts = await db.account.findMany({
                    where: { tenantId, accountId: { in: [...allAccountIds] } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) if (a.name) accountNameMap[a.accountId] = a.name;
            } catch (e) {
                console.warn('Could not fetch account names for certificates:', e);
            }
        }

        const certificates = result.certificates.map(c => {
            const ids = [...(accountIdsByCert.get(c.id) ?? [])];
            return {
                ...c,
                associatedAccountIds: ids,
                associatedAccountNames: ids.map(id => accountNameMap[id] || id),
            };
        });

        return NextResponse.json({ success: true, data: certificates, total: result.total });
    } catch (error: unknown) {
        console.error('Error fetching certificates:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificates';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('create', 'Certificate');
        if (authError) return authError;

        let name: string;
        let domainName: string;
        let bodyPem: string;
        let chainPem: string | undefined;
        let privateKeyPem: string;

        const contentType = request.headers.get('content-type') || '';
        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            name = formData.get('name') as string;
            domainName = formData.get('domainName') as string;
            const bodyFile = formData.get('body') as File | null;
            const chainFile = formData.get('chain') as File | null;
            const keyFile = formData.get('privateKey') as File | null;
            if (!bodyFile || !keyFile) {
                return NextResponse.json(
                    { success: false, error: 'Certificate body and private key are required' },
                    { status: 400 }
                );
            }
            bodyPem = await bodyFile.text();
            chainPem = chainFile ? await chainFile.text() : undefined;
            privateKeyPem = await keyFile.text();
        } else {
            const json = await request.json();
            name = json.name;
            domainName = json.domainName;
            bodyPem = json.body;
            chainPem = json.chain;
            privateKeyPem = json.privateKey;
        }

        if (!name || !domainName || !bodyPem || !privateKeyPem) {
            return NextResponse.json(
                { success: false, error: 'name, domainName, body, and privateKey are required' },
                { status: 400 }
            );
        }

        // --- validation / authentication of the uploaded material ---
        try {
            parseCertificatePem(bodyPem);
            if (!privateKeyPem.includes('-----BEGIN') || !privateKeyPem.includes('PRIVATE KEY-----')) {
                throw new Error('Invalid private key PEM format');
            }
            validateKeyPair(bodyPem, privateKeyPem);
        } catch (e) {
            return NextResponse.json(
                { success: false, error: e instanceof Error ? e.message : 'Invalid certificate material' },
                { status: 400 }
            );
        }

        const parsed = parseCertificate(bodyPem);
        const status = computeExpiryStatus(parsed.notAfter);

        const certId = randomUUID();
        const prefix = versionS3Prefix(tenantId, certId, 1);
        const keys = await putVersionMaterial(prefix, {
            body: bodyPem,
            chain: chainPem,
            privateKey: privateKeyPem,
        });

        const repo = getCertificateRepository();
        const session = await getServerSession(authOptions);
        const createdBy = session?.user?.email || 'unknown';

        const { certificate } = await repo.createWithInitialVersion({
            id: certId,
            tenantId,
            name,
            domainName,
            createdBy,
            issuer: parsed.issuer,
            notBefore: parsed.notBefore,
            notAfter: parsed.notAfter,
            fingerprint: parsed.fingerprint,
            serialNumber: parsed.serialNumber,
            s3BodyKey: keys.s3BodyKey,
            s3ChainKey: keys.s3ChainKey,
            s3PrivateKeyKey: keys.s3PrivateKeyKey,
            status,
        });

        await AuditService.logUserAction({
            action: 'upload',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: name,
            user: createdBy,
            userType: 'user',
            status: 'success',
            details: `Certificate "${name}" uploaded for domain ${domainName} (v1)`,
            tenantId,
            metadata: { domainName, fingerprint: parsed.fingerprint },
        });

        return NextResponse.json({ success: true, data: certificate }, { status: 201 });
    } catch (error: unknown) {
        console.error('Error uploading certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to upload certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
