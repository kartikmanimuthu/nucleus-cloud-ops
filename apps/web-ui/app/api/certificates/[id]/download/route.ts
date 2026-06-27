import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import JSZip from 'jszip';
import { env } from '@/env';

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

        const s3Client = new S3Client({ region: env.AWS_REGION || 'ap-south-1' });
        const bucket = env.APP_BUCKET_NAME || '';

        // Load all three parts from S3
        const [bodyObj, chainObj, keyObj] = await Promise.all([
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey })),
            cert.s3ChainKey
                ? s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }))
                : Promise.resolve(null),
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey })),
        ]);

        const bodyContent = await bodyObj.Body!.transformToString();
        const chainContent = chainObj ? await chainObj.Body!.transformToString() : null;
        const keyContent = await keyObj.Body!.transformToString();

        // Build ZIP
        const zip = new JSZip();
        zip.file(`${cert.name || 'certificate'}_body.pem`, bodyContent);
        if (chainContent) {
            zip.file(`${cert.name || 'certificate'}_chain.pem`, chainContent);
        }
        zip.file(`${cert.name || 'certificate'}_private.key`, keyContent);

        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

        const safeName = (cert.name || 'certificate').replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${safeName}.zip`;

        return new NextResponse(zipBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${filename}"`,
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
