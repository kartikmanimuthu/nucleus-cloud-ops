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
import { assumeAccountRole, importToAcm } from '@/lib/certificate-aws';

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
                { success: false, error: 'Certificate has no active version to reimport.' },
                { status: 409 }
            );
        }
        // ACM rejects importing expired material (ValidationException). Catch it early with a
        // clear, actionable message instead of a cross-account round trip to a guaranteed failure.
        if (new Date(version.notAfter).getTime() < Date.now()) {
            return NextResponse.json(
                {
                    success: false,
                    code: 'ACTIVE_VERSION_EXPIRED',
                    error: `Active version v${version.version} expired on ${new Date(version.notAfter).toLocaleDateString()}. Upload a renewed certificate version and Make it Active before reimporting (AWS ACM does not accept expired certificates).`,
                },
                { status: 409 }
            );
        }

        // Every place this cert is deployed in the account (acmArn known), across regions.
        const deployments = (await repo.listDeployments(tenantId, certId)).filter(
            d => d.accountId === targetAccountId && d.acmArn
        );
        if (deployments.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'No deployed certificate found in this account. Run Discover (or Deploy) first.',
                    code: 'NOT_DISCOVERED',
                },
                { status: 409 }
            );
        }

        const db = getTenantClient(tenantId);
        const account = await db.account.findFirst({
            where: { tenantId, accountId: targetAccountId },
            select: { roleArn: true, externalId: true, name: true },
        });
        if (!account) {
            return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
        }

        const executionId = randomUUID();
        const startedAt = Date.now();
        const session = await getServerSession(authOptions);
        await repo.createExecution({
            tenantId,
            certificateId: certId,
            executionId,
            operation: 'reimport',
            versionId: version.id,
            accountId: targetAccountId,
            status: 'running',
            triggeredBy: session?.user?.email || 'unknown',
            expiresAt: new Date(Date.now() + TTL_90_DAYS_MS).toISOString(),
        });

        const material = await loadVersionMaterial(version);
        const perRegion: Array<{ region: string; arn: string | null; ok: boolean; error?: string }> = [];

        console.log(
            `[reimport] cert=${certId} account=${targetAccountId} version=v${version.version} ` +
            `regions=[${deployments.map(d => d.region).join(',')}] roleArn=${account.roleArn} ` +
            `material={bodyLen:${material.body.length},chain:${material.chain ? material.chain.length : 0},keyLen:${material.privateKey.length}}`
        );

        for (const dep of deployments) {
            try {
                const creds = await assumeAccountRole(
                    { accountId: targetAccountId, roleArn: account.roleArn, externalId: account.externalId },
                    dep.region,
                    'cert-reimport'
                );
                if (!creds) throw new Error(`AssumeRole returned no credentials for ${account.roleArn}`);
                console.log(`[reimport] assumed role ok, importing to ARN=${dep.acmArn} region=${dep.region}`);
                const arn = await importToAcm(creds, dep.region, {
                    body: material.body,
                    privateKey: material.privateKey,
                    chain: material.chain,
                    arn: dep.acmArn!,
                });
                await repo.upsertDeployment({
                    tenantId,
                    certificateId: certId,
                    accountId: targetAccountId,
                    region: dep.region,
                    acmArn: arn,
                    acmDomainName: cert.domainName,
                    acmNotAfter: version.notAfter,
                    acmStatus: 'ISSUED',
                    deployedVersionId: version.id,
                    linkState: 'deployed',
                    lastScannedAt: new Date().toISOString(),
                    lastDeployedAt: new Date().toISOString(),
                });
                perRegion.push({ region: dep.region, arn, ok: true });
            } catch (e) {
                const errName = e instanceof Error ? e.name : 'Error';
                const errMsg = e instanceof Error ? e.message : 'reimport failed';
                // Surface the real AWS error (STS AccessDenied, ACM ValidationException, S3 NoSuchKey, …).
                console.error(
                    `[reimport] FAILED cert=${certId} account=${targetAccountId} region=${dep.region} ` +
                    `arn=${dep.acmArn} ${errName}: ${errMsg}`,
                    e
                );
                perRegion.push({
                    region: dep.region,
                    arn: dep.acmArn,
                    ok: false,
                    error: `${errName}: ${errMsg}`,
                });
            }
        }

        const okCount = perRegion.filter(r => r.ok).length;
        const status = okCount === perRegion.length ? 'success' : okCount === 0 ? 'failed' : 'partial';
        const firstError = perRegion.find(r => !r.ok)?.error;
        const summary =
            `Reimported v${version.version} to ${okCount}/${perRegion.length} region(s) in ${account.name}` +
            (firstError ? ` — ${firstError}` : '');
        await repo.finishExecution(tenantId, executionId, {
            status,
            message: summary,
            details: perRegion,
            duration: Math.round((Date.now() - startedAt) / 1000),
        });

        await AuditService.logUserAction({
            action: 'reimport',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: status === 'failed' ? 'error' : 'success',
            details: `Certificate "${cert.name}" v${version.version} reimported to ${okCount}/${perRegion.length} region(s) in ${account.name} (${targetAccountId})`,
            tenantId,
            metadata: { accountId: targetAccountId, version: version.version, perRegion },
        });

        return NextResponse.json({
            success: status !== 'failed',
            ...(status !== 'success' ? { error: summary } : {}),
            data: { accountId: targetAccountId, version: version.version, perRegion, status },
        });
    } catch (error: unknown) {
        console.error('Error reimporting certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to reimport certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
