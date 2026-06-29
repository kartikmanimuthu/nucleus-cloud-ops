import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getTenantClient } from '@/lib/db/pg-config';
import {
    assumeAccountRole,
    scanAccountCertificates,
    scannedCertMatchesDomain,
    runBounded,
} from '@/lib/certificate-aws';

const TTL_90_DAYS_MS = 90 * 86400000;
const CONCURRENCY = 10;
const PER_TASK_TIMEOUT_MS = 12_000;
const OVERALL_BUDGET_MS = 50_000;

interface TaskResult {
    accountId: string;
    region: string;
    matched: boolean;
    skipped?: boolean;
    error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('update', 'Certificate');
        if (authError) return authError;

        const { id: certId } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        const db = getTenantClient(tenantId);
        const accounts = await db.account.findMany({
            where: { tenantId, active: true },
            select: { accountId: true, name: true, roleArn: true, externalId: true, regions: true },
        });

        // Build (account, region) scan tasks over each account's configured regions.
        const units: Array<{ accountId: string; roleArn: string; externalId: string | null; region: string }> = [];
        for (const a of accounts) {
            const regions = a.regions?.length ? a.regions : ['us-east-1'];
            for (const region of regions) {
                units.push({ accountId: a.accountId, roleArn: a.roleArn, externalId: a.externalId, region });
            }
        }

        const executionId = randomUUID();
        const startedAt = Date.now();
        const deadline = startedAt + OVERALL_BUDGET_MS;

        const tasks = units.map(unit => async (): Promise<TaskResult> => {
            if (Date.now() > deadline) {
                return { accountId: unit.accountId, region: unit.region, matched: false, skipped: true };
            }
            try {
                const creds = await withTimeout(
                    assumeAccountRole(
                        { accountId: unit.accountId, roleArn: unit.roleArn, externalId: unit.externalId },
                        unit.region,
                        'cert-discover'
                    ),
                    PER_TASK_TIMEOUT_MS,
                    'assumeRole'
                );
                if (!creds) {
                    return { accountId: unit.accountId, region: unit.region, matched: false, error: 'assume role failed' };
                }
                const scanned = await withTimeout(
                    scanAccountCertificates(creds, unit.region),
                    PER_TASK_TIMEOUT_MS,
                    'acm scan'
                );
                const match = scanned.find(c => scannedCertMatchesDomain(c, cert.domainName));
                if (match) {
                    await repo.upsertDeployment({
                        tenantId,
                        certificateId: certId,
                        accountId: unit.accountId,
                        region: unit.region,
                        acmArn: match.arn,
                        acmDomainName: match.domainName,
                        acmNotAfter: match.notAfter ? match.notAfter.toISOString() : null,
                        acmStatus: match.status ?? null,
                        linkState: 'deployed',
                        inUseByCount: match.inUseBy.length,
                        lastScannedAt: new Date().toISOString(),
                    });
                    await repo.deleteUnknownRegionDeployments(tenantId, certId, unit.accountId);
                    return { accountId: unit.accountId, region: unit.region, matched: true };
                }
                return { accountId: unit.accountId, region: unit.region, matched: false };
            } catch (e) {
                return {
                    accountId: unit.accountId,
                    region: unit.region,
                    matched: false,
                    error: e instanceof Error ? e.message : 'scan failed',
                };
            }
        });

        const settled = await runBounded(tasks, CONCURRENCY);
        const results: TaskResult[] = settled.map((r, i) =>
            r.status === 'fulfilled'
                ? r.value
                : { accountId: units[i].accountId, region: units[i].region, matched: false, error: 'task error' }
        );

        const matched = results.filter(r => r.matched).length;
        const skipped = results.filter(r => r.skipped).length;
        const errored = results.filter(r => r.error).length;
        const status = skipped > 0 || errored > 0 ? 'partial' : 'success';

        await repo.createExecution({
            tenantId,
            certificateId: certId,
            executionId,
            operation: 'discover',
            status: 'running',
            triggeredBy: 'web-ui',
            expiresAt: new Date(Date.now() + TTL_90_DAYS_MS).toISOString(),
        });
        await repo.finishExecution(tenantId, executionId, {
            status,
            message: `Scanned ${units.length} account/region target(s): ${matched} matched, ${errored} error(s), ${skipped} skipped`,
            details: { results, accountsScanned: accounts.length },
            duration: Math.round((Date.now() - startedAt) / 1000),
        });

        await AuditService.logUserAction({
            action: 'discover',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: 'web-ui',
            userType: 'user',
            status: status === 'partial' ? 'warning' : 'success',
            details: `Discover scan for "${cert.name}": ${matched} ACM match(es) across ${accounts.length} active account(s)`,
            tenantId,
            metadata: { matched, errored, skipped, targets: units.length },
        });

        return NextResponse.json({
            success: true,
            data: {
                status,
                matched,
                errored,
                skipped,
                targets: units.length,
                accountsScanned: accounts.length,
                results,
            },
        });
    } catch (error: unknown) {
        console.error('Error running certificate discover:', error);
        const message = error instanceof Error ? error.message : 'Failed to run discover';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
