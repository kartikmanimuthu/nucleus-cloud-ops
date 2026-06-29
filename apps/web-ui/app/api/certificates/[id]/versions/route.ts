import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { computeExpiryStatus, parseCertificatePem } from '@/lib/certificate-utils';
import { parseCertificate, validateKeyPair, certificateCoversDomain } from '@/lib/certificate-crypto';
import { putVersionMaterial, versionS3Prefix } from '@/lib/certificate-material';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const { id } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, id);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }
        const versions = await repo.listVersions(tenantId, id);
        return NextResponse.json({ success: true, data: versions });
    } catch (error: unknown) {
        console.error('Error listing certificate versions:', error);
        const message = error instanceof Error ? error.message : 'Failed to list versions';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('update', 'Certificate');
        if (authError) return authError;

        const { id: certId } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        let bodyPem: string;
        let chainPem: string | undefined;
        let privateKeyPem: string;
        let activate = false;

        const contentType = request.headers.get('content-type') || '';
        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
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
            activate = formData.get('activate') === 'true';
        } else {
            const json = await request.json();
            bodyPem = json.body;
            chainPem = json.chain;
            privateKeyPem = json.privateKey;
            activate = json.activate === true;
        }

        if (!bodyPem || !privateKeyPem) {
            return NextResponse.json(
                { success: false, error: 'body and privateKey are required' },
                { status: 400 }
            );
        }

        // --- validation ---
        try {
            parseCertificatePem(bodyPem);
            if (!privateKeyPem.includes('-----BEGIN') || !privateKeyPem.includes('PRIVATE KEY-----')) {
                throw new Error('Invalid private key PEM format');
            }
            validateKeyPair(bodyPem, privateKeyPem);
            if (!certificateCoversDomain(bodyPem, cert.domainName)) {
                throw new Error(
                    `New version does not cover the certificate domain "${cert.domainName}"`
                );
            }
        } catch (e) {
            return NextResponse.json(
                { success: false, error: e instanceof Error ? e.message : 'Invalid certificate material' },
                { status: 400 }
            );
        }

        const parsed = parseCertificate(bodyPem);

        // Dedup: same material already exists as a version.
        if (parsed.fingerprint) {
            const dup = await repo.findVersionByFingerprint(tenantId, certId, parsed.fingerprint);
            if (dup) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `Identical certificate material already exists as version ${dup.version}`,
                        code: 'DUPLICATE_MATERIAL',
                        data: { version: dup },
                    },
                    { status: 409 }
                );
            }
        }

        const version = await repo.nextVersionNumber(tenantId, certId);
        const prefix = versionS3Prefix(tenantId, certId, version);
        const keys = await putVersionMaterial(prefix, {
            body: bodyPem,
            chain: chainPem,
            privateKey: privateKeyPem,
        });

        const session = await getServerSession(authOptions);
        const uploadedBy = session?.user?.email || 'unknown';
        const status = computeExpiryStatus(parsed.notAfter);

        const created = await repo.createVersion({
            tenantId,
            certificateId: certId,
            version,
            issuer: parsed.issuer,
            notBefore: parsed.notBefore,
            notAfter: parsed.notAfter,
            fingerprint: parsed.fingerprint,
            serialNumber: parsed.serialNumber,
            s3BodyKey: keys.s3BodyKey,
            s3ChainKey: keys.s3ChainKey,
            s3PrivateKeyKey: keys.s3PrivateKeyKey,
            status,
            uploadedBy,
        });

        if (activate) {
            await repo.activateVersion(tenantId, certId, created.id);
        }

        await AuditService.logUserAction({
            action: 'upload_version',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: uploadedBy,
            userType: 'user',
            status: 'success',
            details: `Uploaded version ${version} for "${cert.name}"${activate ? ' (activated)' : ''}`,
            tenantId,
            metadata: { version, fingerprint: parsed.fingerprint, activated: activate },
        });

        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error: unknown) {
        console.error('Error creating certificate version:', error);
        const message = error instanceof Error ? error.message : 'Failed to create version';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
