import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getTenantClient } from '@/lib/db/pg-config';
import { loadVersionMaterial } from '@/lib/certificate-material';
import {
    assumeAccountRole,
    scanAccountCertificates,
    scannedCertMatchesDomain,
    importToAcm,
} from '@/lib/certificate-aws';

const TTL_90_DAYS_MS = 90 * 86400000;

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
        const targetRegion = body.region as string | undefined;
        const force = body.force === true;

        if (!targetAccountId) {
            return NextResponse.json({ success: false, error: 'accountId is required' }, { status: 400 });
        }

        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        const version = await repo.getActiveVersion(tenantId, certId);
        if (!version) {
            return NextResponse.json(
                { success: false, error: 'Certificate has no active version to deploy.' },
                { status: 409 }
            );
        }
        // ACM rejects importing expired material — fail early with a clear message.
        if (new Date(version.notAfter).getTime() < Date.now()) {
            return NextResponse.json(
                {
                    success: false,
                    code: 'ACTIVE_VERSION_EXPIRED',
                    error: `Active version v${version.version} expired on ${new Date(version.notAfter).toLocaleDateString()}. Upload a renewed certificate version and Make it Active before deploying (AWS ACM does not accept expired certificates).`,
                },
                { status: 409 }
            );
        }

        const db = getTenantClient(tenantId);
        const account = await db.account.findFirst({
            where: { tenantId, accountId: targetAccountId },
            select: { roleArn: true, externalId: true, regions: true, name: true, active: true },
        });
        if (!account) {
            return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
        }
        if (!account.active) {
            return NextResponse.json(
                { success: false, error: 'Account is not active' },
                { status: 400 }
            );
        }

        const region = targetRegion || account.regions[0] || 'us-east-1';
        const creds = await assumeAccountRole(
            { accountId: targetAccountId, roleArn: account.roleArn, externalId: account.externalId },
            region,
            'cert-deploy'
        );
        if (!creds) {
            return NextResponse.json(
                { success: false, error: 'Failed to assume role into target account' },
                { status: 500 }
            );
        }

        // Pre-deploy validation: is the certificate already present in this account/region?
        const scanned = await scanAccountCertificates(creds, region);
        const existing = scanned.find(c => scannedCertMatchesDomain(c, cert.domainName));
        const existingArn = existing?.arn ?? (await repo.getDeployment(tenantId, certId, targetAccountId, region))?.acmArn ?? null;

        if (existingArn && !force) {
            // Record/refresh the link so Reimport can target it, but do not duplicate.
            await repo.upsertDeployment({
                tenantId,
                certificateId: certId,
                accountId: targetAccountId,
                region,
                acmArn: existingArn,
                acmDomainName: existing?.domainName ?? cert.domainName,
                acmNotAfter: existing?.notAfter ? existing.notAfter.toISOString() : null,
                acmStatus: existing?.status ?? null,
                linkState: 'deployed',
                inUseByCount: existing?.inUseBy.length ?? 0,
                lastScannedAt: new Date().toISOString(),
            });
            return NextResponse.json(
                {
                    success: false,
                    error: 'Certificate already present in this account/region. Use Reimport to update it in place.',
                    code: 'ALREADY_PRESENT',
                    data: { acmArn: existingArn, region },
                },
                { status: 409 }
            );
        }

        // Execution record (running → final).
        const executionId = randomUUID();
        const startedAt = Date.now();
        await repo.createExecution({
            tenantId,
            certificateId: certId,
            executionId,
            operation: 'deploy',
            versionId: version.id,
            accountId: targetAccountId,
            region,
            status: 'running',
            triggeredBy: (await getServerSession(authOptions))?.user?.email || 'unknown',
            expiresAt: new Date(Date.now() + TTL_90_DAYS_MS).toISOString(),
        });

        try {
            const material = await loadVersionMaterial(version);
            const arn = await importToAcm(creds, region, {
                body: material.body,
                privateKey: material.privateKey,
                chain: material.chain,
                ...(existingArn ? { arn: existingArn } : {}),
            });

            await repo.upsertDeployment({
                tenantId,
                certificateId: certId,
                accountId: targetAccountId,
                region,
                acmArn: arn,
                acmDomainName: cert.domainName,
                acmNotAfter: version.notAfter,
                acmStatus: 'ISSUED',
                deployedVersionId: version.id,
                linkState: 'deployed',
                lastScannedAt: new Date().toISOString(),
                lastDeployedAt: new Date().toISOString(),
            });
            await repo.deleteUnknownRegionDeployments(tenantId, certId, targetAccountId);

            await repo.finishExecution(tenantId, executionId, {
                status: 'success',
                acmArn: arn,
                message: `Deployed v${version.version} to ${account.name} (${targetAccountId}) / ${region}`,
                duration: Math.round((Date.now() - startedAt) / 1000),
            });

            const session = await getServerSession(authOptions);
            await AuditService.logUserAction({
                action: 'deploy',
                resourceType: 'certificate',
                resourceId: certId,
                resourceName: cert.name,
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: `Certificate "${cert.name}" v${version.version} deployed to ACM in ${account.name} (${targetAccountId}) / ${region}`,
                tenantId,
                metadata: { accountId: targetAccountId, region, certificateArn: arn, version: version.version },
            });

            return NextResponse.json({ success: true, data: { certificateArn: arn, accountId: targetAccountId, region } });
        } catch (deployErr) {
            await repo.finishExecution(tenantId, executionId, {
                status: 'failed',
                message: deployErr instanceof Error ? deployErr.message : 'Deploy failed',
                duration: Math.round((Date.now() - startedAt) / 1000),
            });
            throw deployErr;
        }
    } catch (error: unknown) {
        console.error('Error deploying certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to deploy certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
