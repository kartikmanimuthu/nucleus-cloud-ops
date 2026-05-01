import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

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

        return NextResponse.json({ success: true, data: cert });
    } catch (error: unknown) {
        console.error('Error fetching certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('delete', 'Certificate');
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

        const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const bucket = process.env.APP_BUCKET_NAME || '';
        const keys = [cert.s3BodyKey, cert.s3PrivateKeyKey];
        if (cert.s3ChainKey) keys.push(cert.s3ChainKey);

        await Promise.all(
            keys.map(key =>
                s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
            )
        );

        await repo.deleteCertificate(tenantId, id);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'delete',
            resourceType: 'certificate',
            resourceId: id,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Certificate "${cert.name}" deleted`,
            tenantId,
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Error deleting certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
