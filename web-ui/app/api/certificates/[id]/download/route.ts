import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const { id } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, id);

        if (!cert) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const bucket = process.env.APP_BUCKET_NAME || '';

        const [bodyUrl, chainUrl, keyUrl] = await Promise.all([
            getSignedUrl(
                s3Client,
                new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey }),
                { expiresIn: 3600 }
            ),
            cert.s3ChainKey
                ? getSignedUrl(
                      s3Client,
                      new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }),
                      { expiresIn: 3600 }
                  )
                : Promise.resolve(null),
            getSignedUrl(
                s3Client,
                new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey }),
                { expiresIn: 3600 }
            ),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                bodyUrl,
                chainUrl,
                privateKeyUrl: keyUrl,
                name: cert.name,
                domainName: cert.domainName,
            },
        });
    } catch (error: unknown) {
        console.error('Error downloading certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to download certificate';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
