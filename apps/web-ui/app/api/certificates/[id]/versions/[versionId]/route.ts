import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { deleteMaterial } from '@/lib/certificate-material';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; versionId: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('update', 'Certificate');
        if (authError) return authError;

        const { id: certId, versionId } = await params;
        const repo = getCertificateRepository();

        const cert = await repo.getCertificate(tenantId, certId);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }
        const version = await repo.getVersion(tenantId, certId, versionId);
        if (!version) {
            return NextResponse.json({ success: false, error: 'Version not found' }, { status: 404 });
        }
        if (version.isActive) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Cannot delete the active version. Activate another version first, or delete the certificate.',
                    code: 'ACTIVE_VERSION',
                },
                { status: 409 }
            );
        }

        await deleteMaterial([version.s3BodyKey, version.s3ChainKey, version.s3PrivateKeyKey]);
        await repo.deleteVersion(tenantId, certId, versionId);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'delete_version',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Deleted version ${version.version} of "${cert.name}"`,
            tenantId,
            metadata: { version: version.version },
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Error deleting certificate version:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete version';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
