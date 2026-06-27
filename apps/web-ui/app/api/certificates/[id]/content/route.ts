import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '@/env';

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
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        const s3Client = new S3Client({ region: env.AWS_REGION || 'ap-south-1' });
        const bucket = env.APP_BUCKET_NAME || '';

        const [bodyObj, chainObj, keyObj] = await Promise.all([
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey })),
            cert.s3ChainKey
                ? s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }))
                : Promise.resolve(null),
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey })),
        ]);

        const body = await bodyObj.Body!.transformToString();
        const chain = chainObj ? await chainObj.Body!.transformToString() : undefined;
        const privateKey = await keyObj.Body!.transformToString();

        return NextResponse.json({
            success: true,
            data: { body, chain, privateKey },
        });
    } catch (error: unknown) {
        console.error('Error fetching certificate content:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificate content';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
