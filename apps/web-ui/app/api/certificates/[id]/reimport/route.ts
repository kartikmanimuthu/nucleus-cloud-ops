import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ACMClient, ImportCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getTenantClient } from '@/lib/db/pg-config';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('update', 'Certificate');
        if (authError) return authError;

        const { id: certId } = await params;
        const body = await request.json();
        const targetAccountId = body.accountId as string;

        if (!targetAccountId) {
            return NextResponse.json(
                { success: false, error: 'accountId is required' },
                { status: 400 }
            );
        }

        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);

        if (!cert) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        if (!cert.associatedAccountIds.includes(targetAccountId)) {
            return NextResponse.json(
                { success: false, error: 'Certificate not associated with this account' },
                { status: 400 }
            );
        }

        // Get account details
        const db = getTenantClient(tenantId);
        const account = await db.account.findFirst({
            where: { tenantId, accountId: targetAccountId },
            select: { roleArn: true, externalId: true, regions: true, name: true },
        });

        if (!account) {
            return NextResponse.json(
                { success: false, error: 'Account not found' },
                { status: 404 }
            );
        }

        // Load certificate files from S3
        const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const bucket = process.env.APP_BUCKET_NAME || '';

        const [bodyObj, chainObj, keyObj] = await Promise.all([
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey })),
            cert.s3ChainKey
                ? s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }))
                : Promise.resolve(null),
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey })),
        ]);

        const certBody = await bodyObj.Body!.transformToString();
        const certChain = chainObj ? await chainObj.Body!.transformToString() : undefined;
        const privateKey = await keyObj.Body!.transformToString();

        // STS AssumeRole into target account
        const stsClient = new STSClient({ region: account.regions[0] || 'us-east-1' });
        const { Credentials } = await stsClient.send(
            new AssumeRoleCommand({
                RoleArn: account.roleArn,
                RoleSessionName: 'cert-reimport',
                ...(account.externalId ? { ExternalId: account.externalId } : {}),
            })
        );

        if (!Credentials) {
            return NextResponse.json(
                { success: false, error: 'Failed to assume role into target account' },
                { status: 500 }
            );
        }

        // Find the existing ACM certificate ARN from inventory
        const acmResources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                accountId: targetAccountId,
                resourceType: 'acm_certificates',
            },
            select: { resourceId: true, metadata: true },
        });

        const matchingAcmCert = acmResources.find(r => {
            const meta = r.metadata as Record<string, unknown>;
            return (meta?.domainName as string || '').toLowerCase() === cert.domainName.toLowerCase();
        });

        const certificateArn = matchingAcmCert?.resourceId;

        // Reimport to ACM
        const acmClient = new ACMClient({
            region: account.regions[0] || 'us-east-1',
            credentials: {
                accessKeyId: Credentials.AccessKeyId!,
                secretAccessKey: Credentials.SecretAccessKey!,
                sessionToken: Credentials.SessionToken!,
            },
        });

        const importCommand = new ImportCertificateCommand({
            Certificate: Buffer.from(certBody),
            PrivateKey: Buffer.from(privateKey),
            ...(certChain ? { CertificateChain: Buffer.from(certChain) } : {}),
            ...(certificateArn ? { CertificateArn: certificateArn } : {}),
        });

        const result = await acmClient.send(importCommand);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'reimport',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Certificate "${cert.name}" reimported to ACM in account ${account.name} (${targetAccountId})`,
            tenantId,
            metadata: {
                accountId: targetAccountId,
                accountName: account.name,
                certificateArn: result.CertificateArn,
            },
        });

        return NextResponse.json({
            success: true,
            data: {
                certificateArn: result.CertificateArn,
                accountId: targetAccountId,
            },
        });
    } catch (error: unknown) {
        console.error('Error reimporting certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to reimport certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
