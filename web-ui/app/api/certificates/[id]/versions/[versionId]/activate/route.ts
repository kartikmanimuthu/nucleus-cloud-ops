import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function POST(
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
            return NextResponse.json({ success: true, data: { alreadyActive: true } });
        }

        await repo.activateVersion(tenantId, certId, versionId);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'activate_version',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Activated version ${version.version} for "${cert.name}" (platform-side; deploy/reimport to apply to accounts)`,
            tenantId,
            metadata: { version: version.version },
        });

        return NextResponse.json({ success: true, data: { activeVersionId: versionId } });
    } catch (error: unknown) {
        console.error('Error activating certificate version:', error);
        const message = error instanceof Error ? error.message : 'Failed to activate version';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
