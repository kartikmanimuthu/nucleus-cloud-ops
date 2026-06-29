import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { loadVersionMaterial } from '@/lib/certificate-material';
import JSZip from 'jszip';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const { id } = await params;
        const { searchParams } = new URL(request.url);
        const versionId = searchParams.get('versionId');

        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, id);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        const version = versionId
            ? await repo.getVersion(tenantId, id, versionId)
            : await repo.getActiveVersion(tenantId, id);
        if (!version) {
            return NextResponse.json(
                { success: false, error: 'No certificate material available' },
                { status: 404 }
            );
        }

        const material = await loadVersionMaterial(version);
        const base = `${cert.name || 'certificate'}_v${version.version}`;

        const zip = new JSZip();
        zip.file(`${base}_body.pem`, material.body);
        if (material.chain) zip.file(`${base}_chain.pem`, material.chain);
        zip.file(`${base}_private.key`, material.privateKey);
        const zipBuffer = await zip.generateAsync({ type: 'uint8array' });

        const safeName = `${cert.name || 'certificate'}_v${version.version}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        return new NextResponse(zipBuffer as unknown as BodyInit, {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${safeName}.zip"`,
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
