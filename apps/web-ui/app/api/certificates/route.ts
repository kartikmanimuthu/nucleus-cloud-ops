import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseCertificatePem, computeExpiryStatus } from '@/lib/certificate-utils';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { X509Certificate } from 'crypto';

function getS3Client(): S3Client {
    return new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
}

const APP_BUCKET = process.env.APP_BUCKET_NAME || '';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const repo = getCertificateRepository();
        const result = await repo.listCertificates({
            tenantId,
            status: searchParams.get('status') as 'active' | 'expiring' | 'expired' | undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        const distinctAccountIds = [
            ...new Set(result.certificates.flatMap(c => c.associatedAccountIds)),
        ];
        const accountNameMap: Record<string, string> = {};
        if (distinctAccountIds.length > 0) {
            try {
                const accounts = await getTenantClient(tenantId).account.findMany({
                    where: { tenantId, accountId: { in: distinctAccountIds } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) {
                    if (a.name) accountNameMap[a.accountId] = a.name;
                }
            } catch (e) {
                console.warn('Could not fetch account names for certificates:', e);
            }
        }

        const certificates = result.certificates.map(c => ({
            ...c,
            associatedAccountNames: c.associatedAccountIds
                .map(id => accountNameMap[id] || id)
                .filter(Boolean),
        }));

        return NextResponse.json({
            success: true,
            data: certificates,
            total: result.total,
        });
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

        parseCertificatePem(bodyPem);

        if (!privateKeyPem.includes('-----BEGIN') || !privateKeyPem.includes('PRIVATE KEY-----')) {
            return NextResponse.json(
                { success: false, error: 'Invalid private key PEM format' },
                { status: 400 }
            );
        }

        const x509 = new X509Certificate(bodyPem);
        const notBefore = new Date(x509.validFrom);
        const notAfter = new Date(x509.validTo);
        const issuer = x509.issuer.split('\n').find(l => l.startsWith('O='))?.replace('O=', '') || x509.issuer;
        const status = computeExpiryStatus(notAfter.toISOString());

        const certId = crypto.randomUUID();
        const s3Prefix = `certificates/${tenantId}/${certId}`;

        const s3Client = getS3Client();
        await Promise.all([
            s3Client.send(
                new PutObjectCommand({
                    Bucket: APP_BUCKET,
                    Key: `${s3Prefix}/body.pem`,
                    Body: bodyPem,
                    ContentType: 'application/x-pem-file',
                })
            ),
            chainPem
                ? s3Client.send(
                      new PutObjectCommand({
                          Bucket: APP_BUCKET,
                          Key: `${s3Prefix}/chain.pem`,
                          Body: chainPem,
                          ContentType: 'application/x-pem-file',
                      })
                  )
                : Promise.resolve(),
            s3Client.send(
                new PutObjectCommand({
                    Bucket: APP_BUCKET,
                    Key: `${s3Prefix}/private.key`,
                    Body: privateKeyPem,
                    ContentType: 'application/x-pem-file',
                })
            ),
        ]);

        // Auto-discover associated accounts from inventory
        const associatedAccountIds: string[] = [];
        try {
            const db = getTenantClient(tenantId);
            const matchingResources = await db.inventoryResource.findMany({
                where: {
                    tenantId,
                    resourceType: 'acm_certificates',
                },
                select: { accountId: true, metadata: true },
            });

            const seen = new Set<string>();
            for (const r of matchingResources) {
                const meta = r.metadata as Record<string, unknown> | null;
                const metaDomain = (meta?.domainName as string) || '';
                if (
                    !seen.has(r.accountId) &&
                    metaDomain.toLowerCase() === domainName.toLowerCase()
                ) {
                    associatedAccountIds.push(r.accountId);
                    seen.add(r.accountId);
                }
            }
        } catch (e) {
            console.warn('Could not auto-discover associated accounts:', e);
        }

        const repo = getCertificateRepository();
        const session = await getServerSession(authOptions);

        const certificate = await repo.createCertificate({
            tenantId,
            name,
            domainName,
            status,
            issuer,
            notBefore: notBefore.toISOString(),
            notAfter: notAfter.toISOString(),
            s3BodyKey: `${s3Prefix}/body.pem`,
            s3ChainKey: chainPem ? `${s3Prefix}/chain.pem` : null,
            s3PrivateKeyKey: `${s3Prefix}/private.key`,
            associatedAccountIds,
            tags: {},
            createdBy: session?.user?.email || 'unknown',
        });

        await AuditService.logUserAction({
            action: 'upload',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Certificate "${name}" uploaded for domain ${domainName}`,
            tenantId,
            metadata: { domainName, associatedAccountIds },
        });

        return NextResponse.json({ success: true, data: certificate }, { status: 201 });
    } catch (error: unknown) {
        console.error('Error uploading certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to upload certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
