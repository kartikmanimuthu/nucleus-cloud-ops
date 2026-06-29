import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { deleteMaterial } from '@/lib/certificate-material';
import { AuditService } from '@/lib/audit-service';
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

        const activeVersion = cert.activeVersionId
            ? await repo.getActiveVersion(tenantId, id)
            : null;

        return NextResponse.json({ success: true, data: { ...cert, activeVersion } });
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
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        // Remove S3 material for every version, then cascade-delete DB rows.
        const versions = await repo.listVersions(tenantId, id);
        const keys = versions.flatMap(v => [v.s3BodyKey, v.s3ChainKey, v.s3PrivateKeyKey]);
        await deleteMaterial(keys);
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
            details: `Certificate "${cert.name}" deleted (${versions.length} version(s))`,
            tenantId,
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Error deleting certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
