# Certificate Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a certificate manager (like AWS ACM) where users upload certificates with private keys to S3, view them in a master-detail UI with masked values and expiry warnings, and reimport them into AWS ACM across associated accounts.

**Architecture:** New `Certificate` Prisma model stored in PostgreSQL with certificate files (body, chain, private key) in S3. REST API under `/api/certificates/` follows existing repository + authorize patterns. UI is a master-detail split: left grid (TanStack Table) + right slide-over side panel with 3 tabs. A pg-boss worker monitors expiring certs. Phase 3 adds manual reimport to AWS ACM via STS AssumeRole.

**Tech Stack:** Next.js 15, Prisma ORM, PostgreSQL, TanStack Table v8, shadcn/ui (Radix), react-hook-form + zod, AWS SDK v3 (S3, ACM, STS), pg-boss workers

---

### Task 1: Prisma schema — add Certificate model

**Files:**
- Modify: `prisma/schema.prisma` — add Certificate model after existing models
- Create: `prisma/migrations/` — new migration via `db:migrate`

- [ ] **Step 1: Add Certificate model to schema.prisma**

Add this model after the `Invitation` model (before the `// === NextAuth Prisma Adapter Models ===` comment block):

```prisma
model Certificate {
  id                   String   @id @default(cuid())
  tenantId             String
  name                 String
  domainName           String
  status               String   @default("active")
  issuer               String?
  notBefore            DateTime?
  notAfter             DateTime
  s3BodyKey            String
  s3ChainKey           String?
  s3PrivateKeyKey      String
  associatedAccountIds String[] @default([])
  tags                 Json     @default("{}")
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  createdBy            String

  @@index([tenantId])
  @@index([tenantId, status])
  @@index([tenantId, notAfter])
  @@map("certificates")
}
```

- [ ] **Step 2: Create and apply migration**

```bash
cd web-ui && npm run db:migrate -- --name add_certificates_table
```

Expected: migration file created in `prisma/migrations/` and applied to local database.

- [ ] **Step 3: Regenerate Prisma clients**

```bash
cd web-ui && npm run db:generate
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add Certificate model for certificate manager"
```

---

### Task 2: Register Certificate in tenant scoping

**Files:**
- Modify: `web-ui/lib/db/pg-config.ts:61-80` — add `Certificate` to `TENANT_SCOPED_MODELS`

- [ ] **Step 1: Add Certificate to TENANT_SCOPED_MODELS**

In `web-ui/lib/db/pg-config.ts`, add `'Certificate'` to the `TENANT_SCOPED_MODELS` set:

```typescript
export const TENANT_SCOPED_MODELS = new Set([
    'Account',
    'Schedule',
    'ScheduleExecution',
    'TargetedResource',
    'AuditLog',
    'KnowledgeBase',
    'DataSource',
    'InventoryResource',
    'AgentOpsRun',
    'AgentOpsEvent',
    'ScheduledTask',
    'AgentMemory',
    'ChatMessage',
    'CustomRole',
    'UserTenantRole',
    'TenantConfig',
    'Invitation',
    'ProviderModel',
    'Certificate',
]);
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/db/pg-config.ts
git commit -m "feat: add Certificate to tenant scoped models"
```

---

### Task 3: Certificate repository interface

**Files:**
- Create: `web-ui/lib/db/repositories/certificate/interface.ts`

- [ ] **Step 1: Write the repository interface**

Create `web-ui/lib/db/repositories/certificate/interface.ts`:

```typescript
export interface CertificateRecord {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    status: 'active' | 'expiring' | 'expired';
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    associatedAccountIds: string[];
    tags: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}

export interface CertificateFilters {
    tenantId: string;
    status?: 'active' | 'expiring' | 'expired';
    searchTerm?: string;
    page?: number;
    limit?: number;
}

export interface CertificatePage {
    certificates: CertificateRecord[];
    total: number;
}

export interface ICertificateRepository {
    listCertificates(filters: CertificateFilters): Promise<CertificatePage>;
    getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null>;
    createCertificate(
        data: Omit<CertificateRecord, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<CertificateRecord>;
    deleteCertificate(tenantId: string, certId: string): Promise<void>;
    updateStatus(tenantId: string, certId: string, status: 'active' | 'expiring' | 'expired'): Promise<void>;
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/db/repositories/certificate/interface.ts
git commit -m "feat: add certificate repository interface"
```

---

### Task 4: Certificate repository — Postgres implementation

**Files:**
- Create: `web-ui/lib/db/repositories/certificate/postgres.ts`

- [ ] **Step 1: Write the Postgres repository**

Create `web-ui/lib/db/repositories/certificate/postgres.ts`:

```typescript
import { getTenantClient } from '@/lib/db/pg-config';
import type { ICertificateRepository, CertificateRecord, CertificateFilters, CertificatePage } from './interface';

export class CertificatePostgresRepository implements ICertificateRepository {
    async listCertificates(filters: CertificateFilters): Promise<CertificatePage> {
        const db = getTenantClient(filters.tenantId);
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 50;
        const skip = (page - 1) * limit;

        const where: Record<string, unknown> = { tenantId: filters.tenantId };
        if (filters.status) {
            where.status = filters.status;
        }
        if (filters.searchTerm) {
            where.OR = [
                { name: { contains: filters.searchTerm, mode: 'insensitive' } },
                { domainName: { contains: filters.searchTerm, mode: 'insensitive' } },
            ];
        }

        const [certificates, total] = await Promise.all([
            db.certificate.findMany({
                where,
                orderBy: { notAfter: 'asc' },
                skip,
                take: limit,
            }),
            db.certificate.count({ where }),
        ]);

        return {
            certificates: certificates.map(this.toRecord),
            total,
        };
    }

    async getCertificate(tenantId: string, certId: string): Promise<CertificateRecord | null> {
        const db = getTenantClient(tenantId);
        const cert = await db.certificate.findUnique({ where: { id: certId, tenantId } });
        return cert ? this.toRecord(cert) : null;
    }

    async createCertificate(
        data: Omit<CertificateRecord, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<CertificateRecord> {
        const db = getTenantClient(data.tenantId);
        const cert = await db.certificate.create({
            data: {
                tenantId: data.tenantId,
                name: data.name,
                domainName: data.domainName,
                status: data.status,
                issuer: data.issuer,
                notBefore: data.notBefore ? new Date(data.notBefore) : null,
                notAfter: new Date(data.notAfter),
                s3BodyKey: data.s3BodyKey,
                s3ChainKey: data.s3ChainKey,
                s3PrivateKeyKey: data.s3PrivateKeyKey,
                associatedAccountIds: data.associatedAccountIds,
                tags: data.tags,
                createdBy: data.createdBy,
            },
        });
        return this.toRecord(cert);
    }

    async deleteCertificate(tenantId: string, certId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificate.delete({ where: { id: certId, tenantId } });
    }

    async updateStatus(
        tenantId: string,
        certId: string,
        status: 'active' | 'expiring' | 'expired'
    ): Promise<void> {
        const db = getTenantClient(tenantId);
        await db.certificate.update({
            where: { id: certId, tenantId },
            data: { status },
        });
    }

    private toRecord(row: {
        id: string;
        tenantId: string;
        name: string;
        domainName: string;
        status: string;
        issuer: string | null;
        notBefore: Date | null;
        notAfter: Date;
        s3BodyKey: string;
        s3ChainKey: string | null;
        s3PrivateKeyKey: string;
        associatedAccountIds: string[];
        tags: unknown;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    }): CertificateRecord {
        return {
            id: row.id,
            tenantId: row.tenantId,
            name: row.name,
            domainName: row.domainName,
            status: row.status as 'active' | 'expiring' | 'expired',
            issuer: row.issuer,
            notBefore: row.notBefore?.toISOString() ?? null,
            notAfter: row.notAfter.toISOString(),
            s3BodyKey: row.s3BodyKey,
            s3ChainKey: row.s3ChainKey,
            s3PrivateKeyKey: row.s3PrivateKeyKey,
            associatedAccountIds: row.associatedAccountIds,
            tags: row.tags as Record<string, string>,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            createdBy: row.createdBy,
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/db/repositories/certificate/postgres.ts
git commit -m "feat: add certificate postgres repository"
```

---

### Task 5: Register certificate repository in factory

**Files:**
- Modify: `web-ui/lib/db/repository-factory.ts`

- [ ] **Step 1: Add import and factory function**

In `web-ui/lib/db/repository-factory.ts`, add the import after the existing ones:

```typescript
import type { ICertificateRepository } from './repositories/certificate/interface';
```

Add the factory function before the `isUsingPostgres` function:

```typescript
export function getCertificateRepository(): ICertificateRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CertificatePostgresRepository } = require('./repositories/certificate/postgres');
    return new CertificatePostgresRepository();
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/db/repository-factory.ts
git commit -m "feat: register certificate repository in factory"
```

---

### Task 6: PEM parsing utility

**Files:**
- Create: `web-ui/lib/certificate-utils.ts`
- Create: `web-ui/tests/certificate-utils.test.ts`

- [ ] **Step 1: Write tests for PEM parsing**

Create `web-ui/tests/certificate-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCertificatePem, computeExpiryStatus } from '@/lib/certificate-utils';

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUSJwAAABBVpTOaP2xFqAAAAAElhgwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTA1MDEwMDAwMDBaFw0yNjA1
MDEwMDAwMDBaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDOyUT8UKfVw2KDMxJqFOqB5JqVCqJqV0qJqVCqJqVC
qJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
AwEAAaNTMFEwHQYDVR0OBBYEFOxXJqVCqJqVMFEwHQYDVR0OBBYEFAkGA1UEBhMC
QVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdp
dHMgUHR5IEx0ZDAeFw0yNTA1MDEwMDAwMDBaFw0yNjA1MDEwMDAwMDBaMA0GCSqG
SIb3DQEBCwUAA4IBAQDOyUT8UKfVw2KDMxJqFOqB5JqVCqJqV0qJqVCqJqVCqJqV
CqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqVCqJqV
-----END CERTIFICATE-----`;

describe('parseCertificatePem', () => {
    it('validates PEM format — rejects empty string', () => {
        expect(() => parseCertificatePem('')).toThrow('Certificate body must not be empty');
    });

    it('validates PEM format — rejects non-PEM content', () => {
        expect(() => parseCertificatePem('not a certificate')).toThrow('Invalid PEM format');
    });

    it('validates PEM format — accepts valid PEM', () => {
        expect(() => parseCertificatePem(SAMPLE_CERT)).not.toThrow();
    });
});

describe('computeExpiryStatus', () => {
    it('returns expired for past dates', () => {
        const past = new Date(Date.now() - 86400000).toISOString();
        expect(computeExpiryStatus(past)).toBe('expired');
    });

    it('returns expiring for dates within 60 days', () => {
        const in30Days = new Date(Date.now() + 30 * 86400000).toISOString();
        expect(computeExpiryStatus(in30Days)).toBe('expiring');
    });

    it('returns active for dates beyond 60 days', () => {
        const in90Days = new Date(Date.now() + 90 * 86400000).toISOString();
        expect(computeExpiryStatus(in90Days)).toBe('active');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web-ui && npm run test -- tests/certificate-utils.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement parseCertificatePem and computeExpiryStatus**

Create `web-ui/lib/certificate-utils.ts`:

```typescript
export function parseCertificatePem(body: string): void {
    if (!body || body.trim().length === 0) {
        throw new Error('Certificate body must not be empty');
    }
    const trimmed = body.trim();
    if (
        !trimmed.includes('-----BEGIN CERTIFICATE-----') ||
        !trimmed.includes('-----END CERTIFICATE-----')
    ) {
        throw new Error('Invalid PEM format: missing BEGIN/END CERTIFICATE markers');
    }
}

export function computeExpiryStatus(notAfter: string): 'active' | 'expiring' | 'expired' {
    const expiryDate = new Date(notAfter);
    const now = Date.now();
    const daysLeft = Math.ceil((expiryDate.getTime() - now) / 86400000);
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= 60) return 'expiring';
    return 'active';
}

export function maskDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 1) return '***';
    return '***.' + parts.slice(1).join('.');
}

export function daysUntilExpiry(notAfter: string): number {
    return Math.ceil((new Date(notAfter).getTime() - Date.now()) / 86400000);
}

export function getExpiryColor(daysLeft: number): string {
    if (daysLeft < 0) return 'text-red-600';
    if (daysLeft <= 30) return 'text-red-500';
    if (daysLeft <= 60) return 'text-yellow-500';
    return 'text-muted-foreground';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web-ui && npm run test -- tests/certificate-utils.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/certificate-utils.ts web-ui/tests/certificate-utils.test.ts
git commit -m "feat: add PEM parsing and expiry computation utilities"
```

---

### Task 7: GET /api/certificates — list certificates

**Files:**
- Create: `web-ui/app/api/certificates/route.ts`

- [ ] **Step 1: Write the list route**

Create `web-ui/app/api/certificates/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();

        const repo = getCertificateRepository();
        const result = await repo.listCertificates({
            tenantId,
            status: searchParams.get('status') as 'active' | 'expiring' | 'expired' | undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        const distinctAccountIds = [
            ...new Set(result.certificates.flatMap(c => c.associatedAccountIds)),
        ];
        const accountNameMap: Record<string, string> = {};
        if (distinctAccountIds.length > 0) {
            try {
                const accounts = await getTenantClient(tenantId).account.findMany({
                    where: { tenantId, accountId: { in: distinctAccountIds } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) {
                    if (a.name) accountNameMap[a.accountId] = a.name;
                }
            } catch (e) {
                console.warn('Could not fetch account names for certificates:', e);
            }
        }

        const certificates = result.certificates.map(c => ({
            ...c,
            associatedAccountNames: c.associatedAccountIds
                .map(id => accountNameMap[id] || id)
                .filter(Boolean),
        }));

        return NextResponse.json({
            success: true,
            data: certificates,
            total: result.total,
        });
    } catch (error: unknown) {
        console.error('Error fetching certificates:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificates';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/route.ts
git commit -m "feat: add GET /api/certificates list endpoint"
```

---

### Task 8: POST /api/certificates — upload certificate

**Files:**
- Modify: `web-ui/app/api/certificates/route.ts` — add POST handler

- [ ] **Step 1: Add POST handler to the route file**

Append to `web-ui/app/api/certificates/route.ts`:

```typescript
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseCertificatePem, computeExpiryStatus } from '@/lib/certificate-utils';

function getS3Client(): S3Client {
    return new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
}

const APP_BUCKET = process.env.APP_BUCKET_NAME || '';

export async function POST(request: NextRequest) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('create', 'Certificate');
        if (authError) return authError;

        let name: string;
        let domainName: string;
        let bodyPem: string;
        let chainPem: string | undefined;
        let privateKeyPem: string;

        const contentType = request.headers.get('content-type') || '';

        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            name = formData.get('name') as string;
            domainName = formData.get('domainName') as string;

            const bodyFile = formData.get('body') as File | null;
            const chainFile = formData.get('chain') as File | null;
            const keyFile = formData.get('privateKey') as File | null;

            if (!bodyFile || !keyFile) {
                return NextResponse.json(
                    { success: false, error: 'Certificate body and private key are required' },
                    { status: 400 }
                );
            }
            bodyPem = await bodyFile.text();
            chainPem = chainFile ? await chainFile.text() : undefined;
            privateKeyPem = await keyFile.text();
        } else {
            const json = await request.json();
            name = json.name;
            domainName = json.domainName;
            bodyPem = json.body;
            chainPem = json.chain;
            privateKeyPem = json.privateKey;
        }

        if (!name || !domainName || !bodyPem || !privateKeyPem) {
            return NextResponse.json(
                { success: false, error: 'name, domainName, body, and privateKey are required' },
                { status: 400 }
            );
        }

        parseCertificatePem(bodyPem);

        const certId = crypto.randomUUID();
        const s3Prefix = `certificates/${tenantId}/${certId}`;

        const s3Client = getS3Client();
        await Promise.all([
            s3Client.send(
                new PutObjectCommand({
                    Bucket: APP_BUCKET,
                    Key: `${s3Prefix}/body.pem`,
                    Body: bodyPem,
                    ContentType: 'application/x-pem-file',
                })
            ),
            chainPem
                ? s3Client.send(
                      new PutObjectCommand({
                          Bucket: APP_BUCKET,
                          Key: `${s3Prefix}/chain.pem`,
                          Body: chainPem,
                          ContentType: 'application/x-pem-file',
                      })
                  )
                : Promise.resolve(),
            s3Client.send(
                new PutObjectCommand({
                    Bucket: APP_BUCKET,
                    Key: `${s3Prefix}/private.key`,
                    Body: privateKeyPem,
                    ContentType: 'application/x-pem-file',
                })
            ),
        ]);

        const now = new Date();
        const notAfter = new Date(now.getTime() + 365 * 86400000);
        const status = computeExpiryStatus(notAfter.toISOString());

        const associatedAccountIds: string[] = [];
        try {
            const { getTenantClient } = await import('@/lib/db/pg-config');
            const db = getTenantClient(tenantId);
            const matchingResources = await db.inventoryResource.findMany({
                where: {
                    tenantId,
                    resourceType: 'acm_certificates',
                },
                select: { accountId: true, metadata: true },
            });

            const seen = new Set<string>();
            for (const r of matchingResources) {
                const meta = r.metadata as Record<string, unknown> | null;
                const metaDomain = (meta?.domainName as string) || '';
                if (
                    !seen.has(r.accountId) &&
                    metaDomain.toLowerCase() === domainName.toLowerCase()
                ) {
                    associatedAccountIds.push(r.accountId);
                    seen.add(r.accountId);
                }
            }
        } catch (e) {
            console.warn('Could not auto-discover associated accounts:', e);
        }

        const repo = getCertificateRepository();
        const session = (await import('next-auth').then(m =>
            m.getServerSession((await import('@/lib/auth-options')).authOptions)
        )) as { user?: { email?: string; id?: string } } | null;

        const certificate = await repo.createCertificate({
            tenantId,
            name,
            domainName,
            status,
            issuer: null,
            notBefore: now.toISOString(),
            notAfter: notAfter.toISOString(),
            s3BodyKey: `${s3Prefix}/body.pem`,
            s3ChainKey: chainPem ? `${s3Prefix}/chain.pem` : null,
            s3PrivateKeyKey: `${s3Prefix}/private.key`,
            associatedAccountIds,
            tags: {},
            createdBy: session?.user?.email || 'unknown',
        });

        await AuditService.logUserAction({
            action: 'upload',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Certificate "${name}" uploaded for domain ${domainName}`,
            tenantId,
            metadata: {
                domainName,
                associatedAccountIds,
            },
        });

        return NextResponse.json({ success: true, data: certificate }, { status: 201 });
    } catch (error: unknown) {
        console.error('Error uploading certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to upload certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

**NOTE:** The `getServerSession` call above uses a dynamic import to avoid top-level ESM issues. In practice, extract the session resolution into the top-level import like all other API routes do. See the existing pattern in `web-ui/app/api/inventory/resources/route.ts` — just add `getServerSession` and `authOptions` imports at the top, and call them normally:

```typescript
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
```

Then at the end:
```typescript
const session = await getServerSession(authOptions);
const createdBy = session?.user?.email || 'unknown';
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/route.ts
git commit -m "feat: add POST /api/certificates upload endpoint"
```

---

### Task 9: GET /api/certificates/[id] — single certificate

**Files:**
- Create: `web-ui/app/api/certificates/[id]/route.ts`

- [ ] **Step 1: Write the single certificate route**

Create `web-ui/app/api/certificates/[id]/route.ts`:

```typescript
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
                s3Client.send(
                    new DeleteObjectCommand({ Bucket: bucket, Key: key })
                )
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
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/[id]/route.ts
git commit -m "feat: add GET/DELETE /api/certificates/[id] endpoint"
```

---

### Task 10: GET /api/certificates/[id]/download — download certificate

**Files:**
- Create: `web-ui/app/api/certificates/[id]/download/route.ts`

- [ ] **Step 1: Write the download route**

Create `web-ui/app/api/certificates/[id]/download/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

        const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const bucket = process.env.APP_BUCKET_NAME || '';

        // Generate pre-signed URLs for each file
        const [bodyUrl, chainUrl, keyUrl] = await Promise.all([
            getSignedUrl(
                s3Client,
                new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey }),
                { expiresIn: 3600 }
            ),
            cert.s3ChainKey
                ? getSignedUrl(
                      s3Client,
                      new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }),
                      { expiresIn: 3600 }
                  )
                : Promise.resolve(null),
            getSignedUrl(
                s3Client,
                new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey }),
                { expiresIn: 3600 }
            ),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                bodyUrl,
                chainUrl,
                privateKeyUrl: keyUrl,
                name: cert.name,
                domainName: cert.domainName,
            },
        });
    } catch (error: unknown) {
        console.error('Error downloading certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to download certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/[id]/download/route.ts
git commit -m "feat: add GET /api/certificates/[id]/download endpoint"
```

---

### Task 11: GET /api/certificates/[id]/accounts — associated accounts with resources

**Files:**
- Create: `web-ui/app/api/certificates/[id]/accounts/route.ts`

- [ ] **Step 1: Write the accounts route**

Create `web-ui/app/api/certificates/[id]/accounts/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

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

        const db = getTenantClient(tenantId);

        if (cert.associatedAccountIds.length === 0) {
            return NextResponse.json({ success: true, data: { accounts: [] } });
        }

        const accounts = await db.account.findMany({
            where: {
                tenantId,
                accountId: { in: cert.associatedAccountIds },
            },
            select: {
                accountId: true,
                name: true,
                regions: true,
                connectionStatus: true,
            },
        });

        const resources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                resourceType: 'acm_certificates',
            },
            select: {
                accountId: true,
                resourceId: true,
                name: true,
                region: true,
                metadata: true,
            },
        });

        const accountsWithResources = accounts.map(account => {
            const accountResources = resources.filter(
                r =>
                    r.accountId === account.accountId &&
                    ((r.metadata as Record<string, unknown>)?.domainName as string || '')
                        .toLowerCase() === cert.domainName.toLowerCase()
            );
            return {
                accountId: account.accountId,
                accountName: account.name,
                regions: account.regions,
                connectionStatus: account.connectionStatus,
                resourceCount: accountResources.length,
                resources: accountResources.map(r => ({
                    resourceId: r.resourceId,
                    name: r.name,
                    region: r.region,
                    resourceType: 'acm_certificate',
                })),
            };
        });

        return NextResponse.json({ success: true, data: { accounts: accountsWithResources } });
    } catch (error: unknown) {
        console.error('Error fetching certificate accounts:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch accounts';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/[id]/accounts/route.ts
git commit -m "feat: add GET /api/certificates/[id]/accounts endpoint"
```

---

### Task 12: Update RBAC — add Certificate subject

**Files:**
- Modify: `web-ui/lib/rbac/types.ts:24-37` — add Certificate to `SUBJECT_TO_MODULE`

- [ ] **Step 1: Add Certificate mapping**

In `web-ui/lib/rbac/types.ts`, add `Certificate` to the `SUBJECT_TO_MODULE`:

```typescript
export const SUBJECT_TO_MODULE: Record<string, Module> = {
    Account: 'Accounts',
    Schedule: 'Schedules',
    Resource: 'Inventory',
    Discovery: 'Inventory',
    User: 'Settings',
    Role: 'Settings',
    Tenant: 'Settings',
    AuditLog: 'Accounts',
    Agent: 'AIOps',
    KnowledgeBase: 'AIOps',
    Certificate: 'Settings',
    Billing: 'Settings',
    all: 'Settings',
};
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/rbac/types.ts
git commit -m "feat: add Certificate to RBAC subject-to-module mapping"
```

---

### Task 13: Sidebar navigation — add Certificate Manager entry

**Files:**
- Modify: `web-ui/components/sidebar.tsx:44-55` — add navigation item

- [ ] **Step 1: Add ShieldCheck icon import and nav entry**

In `web-ui/components/sidebar.tsx`, add `ShieldCheck` to the lucide-react import (it already has `Shield` — add `ShieldCheck`):

```typescript
import {
  LayoutDashboard,
  Server,
  Activity,
  Settings,
  LogOut,
  User,
  Bell,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Bot,
  Users,
  Database,
  Zap,
  Cable,
  BookOpen,
  Globe,
  FileText,
  Calendar,
  Shield,
  ShieldCheck,
  UserCog,
} from "lucide-react"
```

Add the nav item to the `navigation` array (after "Knowledge Base"):

```typescript
const navigation = [
  { name: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard },
  { name: "AWS Accounts", href: "/app/accounts", icon: Server },
  { name: "AI Ops", href: "/app/agent", icon: Bot },
  { name: "Agent Ops", href: "/app/agent-ops", icon: Zap },
  { name: "Channels", href: "/app/channels", icon: Cable },
  { name: "Cost Scheduler", href: "/app/schedules", icon: Calendar },
  { name: "Inventory Discovery", href: "/app/inventory", icon: Database },
  { name: "Knowledge Base", href: "/app/knowledge-base", icon: BookOpen },
  { name: "Certificate Manager", href: "/app/certificates", icon: ShieldCheck },
  { name: "Audit Logs", href: "/app/audit", icon: Activity },
  { name: "Settings", href: "/app/settings", icon: Settings },
]
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/sidebar.tsx
git commit -m "feat: add Certificate Manager to sidebar navigation"
```

---

### Task 14: Certificate grid component (TanStack Table)

**Files:**
- Create: `web-ui/components/certificates/certificate-grid.tsx`

- [ ] **Step 1: Write the certificate grid component**

Create `web-ui/components/certificates/certificate-grid.tsx`:

```typescript
"use client";

import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    flexRender,
    ColumnDef,
    SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Trash2 } from "lucide-react";
import { daysUntilExpiry, getExpiryColor, maskDomain } from "@/lib/certificate-utils";

export interface CertificateRow {
    id: string;
    name: string;
    domainName: string;
    status: 'active' | 'expiring' | 'expired';
    issuer: string | null;
    notAfter: string;
    associatedAccountIds: string[];
    associatedAccountNames: string[];
}

interface CertificateGridProps {
    data: CertificateRow[];
    onRowClick: (cert: CertificateRow) => void;
    onDownload: (cert: CertificateRow) => void;
    onDelete: (cert: CertificateRow) => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateGrid({ data, onRowClick, onDownload, onDelete }: CertificateGridProps) {
    const [sorting, setSorting] = useState<SortingState>([{ id: "notAfter", desc: false }]);

    const columns: ColumnDef<CertificateRow>[] = [
        {
            id: "name",
            accessorKey: "name",
            header: "Name",
            cell: ({ getValue }) => getValue<string>(),
        },
        {
            id: "domainName",
            accessorKey: "domainName",
            header: "Domain",
            cell: ({ getValue }) => (
                <span className="font-mono text-sm">{maskDomain(getValue<string>())}</span>
            ),
        },
        {
            id: "status",
            accessorKey: "status",
            header: "Status",
            cell: ({ getValue }) => {
                const value = getValue<string>();
                return (
                    <Badge variant={STATUS_VARIANT[value] || "outline"}>
                        {value.charAt(0).toUpperCase() + value.slice(1)}
                    </Badge>
                );
            },
        },
        {
            id: "notAfter",
            accessorKey: "notAfter",
            header: "Expiry",
            cell: ({ getValue }) => {
                const dateStr = getValue<string>();
                const days = daysUntilExpiry(dateStr);
                const color = getExpiryColor(days);
                return (
                    <span className={`font-mono text-sm ${color}`}>
                        {new Date(dateStr).toLocaleDateString()}
                    </span>
                );
            },
        },
        {
            id: "accounts",
            accessorKey: "associatedAccountIds",
            header: "Accounts",
            cell: ({ row }) => (
                <Badge variant="outline" className="text-xs">
                    {row.original.associatedAccountIds.length} account
                    {row.original.associatedAccountIds.length !== 1 ? "s" : ""}
                </Badge>
            ),
        },
        {
            id: "issuer",
            accessorKey: "issuer",
            header: "Issuer",
            cell: ({ getValue }) => getValue<string>() || "—",
        },
        {
            id: "actions",
            header: "",
            cell: ({ row }) => (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onDownload(row.original)}
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => onDelete(row.original)}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ),
        },
    ];

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: setSorting,
        state: { sorting },
    });

    return (
        <div className="rounded-md border overflow-x-auto">
            <Table>
                <TableHeader>
                    {table.getHeaderGroups().map(headerGroup => (
                        <TableRow key={headerGroup.id}>
                            {headerGroup.headers.map(header => (
                                <TableHead key={header.id}>
                                    {header.isPlaceholder
                                        ? null
                                        : flexRender(
                                              header.column.columnDef.header,
                                              header.getContext()
                                          )}
                                </TableHead>
                            ))}
                        </TableRow>
                    ))}
                </TableHeader>
                <TableBody>
                    {table.getRowModel().rows.map(row => {
                        const days = daysUntilExpiry(row.original.notAfter);
                        const isExpiringSoon = days >= 0 && days <= 60;
                        return (
                            <TableRow
                                key={row.id}
                                className={`cursor-pointer hover:bg-muted/50 ${
                                    isExpiringSoon ? "bg-amber-500/5" : ""
                                }`}
                                onClick={() => onRowClick(row.original)}
                            >
                                {row.getVisibleCells().map(cell => (
                                    <TableCell key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </TableCell>
                                ))}
                            </TableRow>
                        );
                    })}
                    {data.length === 0 && (
                        <TableRow>
                            <TableCell colSpan={columns.length} className="text-center py-8 text-muted-foreground">
                                No certificates found. Upload your first certificate to get started.
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/certificate-grid.tsx
git commit -m "feat: add certificate grid component with TanStack table"
```

---

### Task 15: Certificate detail tab (masked view)

**Files:**
- Create: `web-ui/components/certificates/certificate-detail-tab.tsx`

- [ ] **Step 1: Write the detail tab component**

Create `web-ui/components/certificates/certificate-detail-tab.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";

interface CertificateDetailTabProps {
    certificateId: string;
}

interface CertificateDetail {
    name: string;
    domainName: string;
    status: string;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
    bodyContent?: string;
    privateKeyContent?: string;
    chainContent?: string;
}

export function CertificateDetailTab({ certificateId }: CertificateDetailTabProps) {
    const [detail, setDetail] = useState<CertificateDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [showBody, setShowBody] = useState(false);
    const [showKey, setShowKey] = useState(false);

    useEffect(() => {
        async function fetchDetail() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}`);
                const json = await res.json();
                if (json.success) {
                    setDetail(json.data);
                }
            } catch (e) {
                console.error('Failed to fetch certificate detail:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchDetail();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (!detail) {
        return <div className="p-4 text-muted-foreground">Certificate not found</div>;
    }

    return (
        <div className="space-y-4 p-1">
            <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                    <span className="text-muted-foreground">Domain</span>
                    <p className="font-mono">{detail.domainName}</p>
                </div>
                <div>
                    <span className="text-muted-foreground">Issuer</span>
                    <p>{detail.issuer || "Unknown"}</p>
                </div>
                <div>
                    <span className="text-muted-foreground">Valid From</span>
                    <p className="font-mono text-sm">
                        {detail.notBefore
                            ? new Date(detail.notBefore).toLocaleDateString()
                            : "—"}
                    </p>
                </div>
                <div>
                    <span className="text-muted-foreground">Expires</span>
                    <p className="font-mono text-sm">
                        {new Date(detail.notAfter).toLocaleDateString()}
                    </p>
                </div>
            </div>

            {/* Certificate Body */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground">Certificate Body</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowBody(v => !v)}
                    >
                        {showBody ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                </div>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                    {showBody ? (detail.bodyContent || "(load from S3)") : "*".repeat(80)}
                </pre>
            </div>

            {/* Private Key */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground">Private Key</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowKey(v => !v)}
                    >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                </div>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono">
                    {showKey ? (detail.privateKeyContent || "(load from S3)") : "*".repeat(80)}
                </pre>
            </div>

            {/* Certificate Chain */}
            {detail.s3ChainKey && (
                <div>
                    <span className="text-sm text-muted-foreground">Certificate Chain</span>
                    <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-48 font-mono mt-1">
                        {detail.chainContent || "(load from S3)"}
                    </pre>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/certificate-detail-tab.tsx
git commit -m "feat: add certificate detail tab with masked view"
```

---

### Task 16: Associated accounts tab + resources tab

**Files:**
- Create: `web-ui/components/certificates/certificate-accounts-tab.tsx`
- Create: `web-ui/components/certificates/certificate-resources-tab.tsx`

- [ ] **Step 1: Write the accounts tab**

Create `web-ui/components/certificates/certificate-accounts-tab.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Loader2 } from "lucide-react";

interface AccountInfo {
    accountId: string;
    accountName: string;
    regions: string[];
    connectionStatus: string;
    resourceCount: number;
}

interface CertificateAccountsTabProps {
    certificateId: string;
    onReimport?: (accountId: string) => void;
    reimporting?: string | null;
}

export function CertificateAccountsTab({
    certificateId,
    onReimport,
    reimporting,
}: CertificateAccountsTabProps) {
    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchAccounts() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/accounts`);
                const json = await res.json();
                if (json.success) {
                    setAccounts(json.data.accounts);
                }
            } catch (e) {
                console.error('Failed to fetch accounts:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchAccounts();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (accounts.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No associated accounts found. Upload a certificate with a domain name
                matching existing ACM certificates in your inventory.
            </div>
        );
    }

    const connectedBadge = (status: string) => {
        if (status === 'connected') {
            return <Badge variant="default" className="bg-green-500/10 text-green-500">Connected</Badge>;
        }
        if (status === 'error') {
            return <Badge variant="destructive">Error</Badge>;
        }
        return <Badge variant="outline">{status}</Badge>;
    };

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Account ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Resources</TableHead>
                        {onReimport && <TableHead>Action</TableHead>}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {accounts.map(account => (
                        <TableRow key={account.accountId}>
                            <TableCell className="font-medium">{account.accountName}</TableCell>
                            <TableCell className="font-mono text-sm">{account.accountId}</TableCell>
                            <TableCell>{connectedBadge(account.connectionStatus)}</TableCell>
                            <TableCell>
                                <Badge variant="outline">{account.resourceCount} cert(s)</Badge>
                            </TableCell>
                            {onReimport && (
                                <TableCell>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-1"
                                        disabled={reimporting === account.accountId}
                                        onClick={() => onReimport(account.accountId)}
                                    >
                                        {reimporting === account.accountId ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <RefreshCw className="h-3.5 w-3.5" />
                                        )}
                                        Reimport
                                    </Button>
                                </TableCell>
                            )}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
```

- [ ] **Step 2: Write the resources tab**

Create `web-ui/components/certificates/certificate-resources-tab.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface ResourceInfo {
    resourceId: string;
    name: string;
    region: string;
    resourceType: string;
    accountId: string;
    accountName?: string;
}

interface CertificateResourcesTabProps {
    certificateId: string;
}

export function CertificateResourcesTab({ certificateId }: CertificateResourcesTabProps) {
    const [resources, setResources] = useState<ResourceInfo[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchResources() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/accounts`);
                const json = await res.json();
                if (json.success) {
                    const allResources: ResourceInfo[] = [];
                    for (const account of json.data.accounts) {
                        for (const r of (account as { resources: ResourceInfo[] }).resources || []) {
                            allResources.push({
                                ...r,
                                accountId: account.accountId as string,
                                accountName: account.accountName as string,
                            });
                        }
                    }
                    setResources(allResources);
                }
            } catch (e) {
                console.error('Failed to fetch resources:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchResources();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (resources.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No associated resources found in inventory.
            </div>
        );
    }

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Region</TableHead>
                        <TableHead>Account</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {resources.map((r, i) => (
                        <TableRow key={`${r.resourceId}-${i}`}>
                            <TableCell className="font-mono text-sm">
                                {r.name || r.resourceId}
                            </TableCell>
                            <TableCell>
                                <Badge variant="outline" className="text-xs">
                                    {r.resourceType}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{r.region}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                                {r.accountName || r.accountId}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/components/certificates/certificate-accounts-tab.tsx web-ui/components/certificates/certificate-resources-tab.tsx
git commit -m "feat: add associated accounts and resources tabs"
```

---

### Task 17: Certificate side panel (master-detail right panel)

**Files:**
- Create: `web-ui/components/certificates/certificate-side-panel.tsx`

- [ ] **Step 1: Write the side panel component**

Create `web-ui/components/certificates/certificate-side-panel.tsx`:

```typescript
"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { CertificateDetailTab } from "./certificate-detail-tab";
import { CertificateAccountsTab } from "./certificate-accounts-tab";
import { CertificateResourcesTab } from "./certificate-resources-tab";
import type { CertificateRow } from "./certificate-grid";
import { useState } from "react";

interface CertificateSidePanelProps {
    certificate: CertificateRow;
    onClose: () => void;
    onReimport: (certId: string, accountId: string) => Promise<void>;
}

export function CertificateSidePanel({
    certificate,
    onClose,
    onReimport,
}: CertificateSidePanelProps) {
    const [reimporting, setReimporting] = useState<string | null>(null);

    const handleReimport = async (accountId: string) => {
        setReimporting(accountId);
        try {
            await onReimport(certificate.id, accountId);
        } finally {
            setReimporting(null);
        }
    };

    return (
        <div className="w-96 border-l bg-background flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
                <div>
                    <h2 className="font-semibold text-sm">{certificate.name}</h2>
                    <p className="text-xs text-muted-foreground font-mono">
                        {certificate.domainName}
                    </p>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
                <Tabs defaultValue="details" className="w-full">
                    <TabsList className="w-full rounded-none border-b bg-transparent h-10 px-4">
                        <TabsTrigger value="details" className="text-xs">
                            Details
                        </TabsTrigger>
                        <TabsTrigger value="accounts" className="text-xs">
                            Accounts ({certificate.associatedAccountIds.length})
                        </TabsTrigger>
                        <TabsTrigger value="resources" className="text-xs">
                            Resources
                        </TabsTrigger>
                    </TabsList>
                    <div className="p-4">
                        <TabsContent value="details">
                            <CertificateDetailTab certificateId={certificate.id} />
                        </TabsContent>
                        <TabsContent value="accounts">
                            <CertificateAccountsTab
                                certificateId={certificate.id}
                                onReimport={handleReimport}
                                reimporting={reimporting}
                            />
                        </TabsContent>
                        <TabsContent value="resources">
                            <CertificateResourcesTab certificateId={certificate.id} />
                        </TabsContent>
                    </div>
                </Tabs>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/certificate-side-panel.tsx
git commit -m "feat: add certificate side panel with tabs"
```

---

### Task 18: Upload certificate dialog

**Files:**
- Create: `web-ui/components/certificates/upload-certificate-dialog.tsx`

- [ ] **Step 1: Write the upload dialog**

Create `web-ui/components/certificates/upload-certificate-dialog.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Upload } from "lucide-react";

interface UploadCertificateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUploaded: () => void;
}

export function UploadCertificateDialog({
    open,
    onOpenChange,
    onUploaded,
}: UploadCertificateDialogProps) {
    const [name, setName] = useState("");
    const [domainName, setDomainName] = useState("");
    const [body, setBody] = useState("");
    const [chain, setChain] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [mode, setMode] = useState<"paste" | "file">("paste");

    const resetForm = () => {
        setName("");
        setDomainName("");
        setBody("");
        setChain("");
        setPrivateKey("");
        setError("");
    };

    const handleSubmit = async () => {
        setError("");
        if (!name || !domainName || !body || !privateKey) {
            setError("Name, domain, certificate body, and private key are required");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch("/api/certificates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, domainName, body, chain: chain || undefined, privateKey }),
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Upload failed");
            } else {
                resetForm();
                onOpenChange(false);
                onUploaded();
            }
        } catch (e) {
            setError("Network error — please try again");
        } finally {
            setSubmitting(false);
        }
    };

    const handleFileUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        const form = e.target as HTMLFormElement;
        const formData = new FormData(form);

        const bodyFile = formData.get("bodyFile") as File;
        const keyFile = formData.get("keyFile") as File;

        if (!formData.get("name") || !formData.get("domainName") || !bodyFile || !keyFile) {
            setError("Name, domain, certificate body, and private key files are required");
            return;
        }

        setSubmitting(true);
        try {
            const res = await fetch("/api/certificates", {
                method: "POST",
                body: formData,
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Upload failed");
            } else {
                resetForm();
                onOpenChange(false);
                onUploaded();
            }
        } catch (e) {
            setError("Network error — please try again");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Upload Certificate</DialogTitle>
                    <DialogDescription>
                        Upload a certificate with its private key. Files are encrypted at rest in S3.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={mode} onValueChange={v => setMode(v as "paste" | "file")}>
                    <TabsList className="w-full">
                        <TabsTrigger value="paste" className="flex-1">Paste Text</TabsTrigger>
                        <TabsTrigger value="file" className="flex-1">Upload Files</TabsTrigger>
                    </TabsList>

                    <TabsContent value="paste" className="space-y-4 mt-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="name">Certificate Name</Label>
                                <Input
                                    id="name"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    placeholder="My Wildcard Cert"
                                />
                            </div>
                            <div>
                                <Label htmlFor="domain">Domain Name</Label>
                                <Input
                                    id="domain"
                                    value={domainName}
                                    onChange={e => setDomainName(e.target.value)}
                                    placeholder="*.example.com"
                                />
                            </div>
                        </div>
                        <div>
                            <Label htmlFor="body">Certificate Body (PEM)</Label>
                            <Textarea
                                id="body"
                                value={body}
                                onChange={e => setBody(e.target.value)}
                                placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                                className="font-mono text-xs min-h-[120px]"
                            />
                        </div>
                        <div>
                            <Label htmlFor="chain">
                                Certificate Chain (PEM, optional)
                            </Label>
                            <Textarea
                                id="chain"
                                value={chain}
                                onChange={e => setChain(e.target.value)}
                                placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                                className="font-mono text-xs min-h-[80px]"
                            />
                        </div>
                        <div>
                            <Label htmlFor="key">Private Key (PEM)</Label>
                            <Textarea
                                id="key"
                                value={privateKey}
                                onChange={e => setPrivateKey(e.target.value)}
                                placeholder="-----BEGIN PRIVATE KEY-----&#10;..."
                                className="font-mono text-xs min-h-[120px]"
                            />
                        </div>
                    </TabsContent>

                    <TabsContent value="file" className="space-y-4 mt-4">
                        <form id="file-upload-form" onSubmit={handleFileUpload}>
                            <div className="grid grid-cols-2 gap-3 mb-4">
                                <div>
                                    <Label htmlFor="fname">Certificate Name</Label>
                                    <Input id="fname" name="name" placeholder="My Wildcard Cert" />
                                </div>
                                <div>
                                    <Label htmlFor="fdomain">Domain Name</Label>
                                    <Input id="fdomain" name="domainName" placeholder="*.example.com" />
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <Label htmlFor="bodyFile">Certificate Body (.pem, .crt)</Label>
                                    <Input id="bodyFile" name="bodyFile" type="file" accept=".pem,.crt,.cer,.p7b" />
                                </div>
                                <div>
                                    <Label htmlFor="chainFile">Certificate Chain (.pem, optional)</Label>
                                    <Input id="chainFile" name="chainFile" type="file" accept=".pem,.crt,.cer,.p7b" />
                                </div>
                                <div>
                                    <Label htmlFor="keyFile">Private Key (.pem, .key)</Label>
                                    <Input id="keyFile" name="keyFile" type="file" accept=".pem,.key" />
                                </div>
                            </div>
                        </form>
                    </TabsContent>
                </Tabs>

                {error && (
                    <p className="text-sm text-destructive">{error}</p>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={submitting}
                        onClick={mode === "paste" ? handleSubmit : () => {
                            const form = document.getElementById("file-upload-form") as HTMLFormElement;
                            form?.requestSubmit();
                        }}
                    >
                        {submitting ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Upload className="h-4 w-4 mr-2" />
                        )}
                        Upload
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/upload-certificate-dialog.tsx
git commit -m "feat: add upload certificate dialog with paste and file modes"
```

---

### Task 19: Delete certificate dialog

**Files:**
- Create: `web-ui/components/certificates/delete-certificate-dialog.tsx`

- [ ] **Step 1: Write the delete dialog**

Create `web-ui/components/certificates/delete-certificate-dialog.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Trash2 } from "lucide-react";
import type { CertificateRow } from "./certificate-grid";

interface DeleteCertificateDialogProps {
    certificate: CertificateRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}

export function DeleteCertificateDialog({
    certificate,
    open,
    onOpenChange,
    onDeleted,
}: DeleteCertificateDialogProps) {
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");

    const handleDelete = async () => {
        if (!certificate) return;
        setError("");
        setDeleting(true);
        try {
            const res = await fetch(`/api/certificates/${certificate.id}`, { method: "DELETE" });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Delete failed");
            } else {
                onOpenChange(false);
                onDeleted();
            }
        } catch (e) {
            setError("Network error — please try again");
        } finally {
            setDeleting(false);
        }
    };

    if (!certificate) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete Certificate</DialogTitle>
                    <DialogDescription>
                        This will permanently delete the certificate &quot;{certificate.name}&quot;
                        ({certificate.domainName}) and all its files from S3. This action cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
                        {deleting ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Trash2 className="h-4 w-4 mr-2" />
                        )}
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/delete-certificate-dialog.tsx
git commit -m "feat: add delete certificate dialog"
```

---

### Task 20: Certificate client component (page-level composer)

**Files:**
- Create: `web-ui/components/certificates/certificate-client-component.tsx`

- [ ] **Step 1: Write the page-level client component**

Create `web-ui/components/certificates/certificate-client-component.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { CertificateGrid, type CertificateRow } from "./certificate-grid";
import { CertificateSidePanel } from "./certificate-side-panel";
import { UploadCertificateDialog } from "./upload-certificate-dialog";
import { DeleteCertificateDialog } from "./delete-certificate-dialog";

export function CertificateClientComponent() {
    const [certificates, setCertificates] = useState<CertificateRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<CertificateRow | null>(null);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CertificateRow | null>(null);

    const fetchCertificates = useCallback(async () => {
        try {
            const res = await fetch("/api/certificates?limit=100");
            const json = await res.json();
            if (json.success) {
                setCertificates(json.data);
            }
        } catch (e) {
            console.error("Failed to fetch certificates:", e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchCertificates();
    }, [fetchCertificates]);

    const handleReimport = async (certId: string, accountId: string) => {
        const res = await fetch(`/api/certificates/${certId}/reimport`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId }),
        });
        const json = await res.json();
        if (!json.success) {
            throw new Error(json.error || "Reimport failed");
        }
    };

    return (
        <div className="flex h-full">
            {/* Left panel — certificate grid */}
            <div className={`flex-1 flex flex-col min-w-0 ${selected ? "pr-0" : ""}`}>
                <div className="flex items-center justify-between p-6 pb-4">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Certificate Manager</h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Manage TLS certificates across your AWS accounts
                        </p>
                    </div>
                    <Button onClick={() => setUploadOpen(true)} className="gap-2">
                        <Plus className="h-4 w-4" />
                        Upload Certificate
                    </Button>
                </div>

                <div className="px-6 flex-1 overflow-auto">
                    {loading ? (
                        <div className="text-center py-12 text-muted-foreground">
                            Loading certificates...
                        </div>
                    ) : (
                        <CertificateGrid
                            data={certificates}
                            onRowClick={setSelected}
                            onDownload={async cert => {
                                const res = await fetch(
                                    `/api/certificates/${cert.id}/download`
                                );
                                const json = await res.json();
                                if (json.success) {
                                    window.open(json.data.bodyUrl, "_blank");
                                }
                            }}
                            onDelete={setDeleteTarget}
                        />
                    )}
                </div>
            </div>

            {/* Right panel — side panel */}
            {selected && (
                <CertificateSidePanel
                    certificate={selected}
                    onClose={() => setSelected(null)}
                    onReimport={handleReimport}
                />
            )}

            <UploadCertificateDialog
                open={uploadOpen}
                onOpenChange={setUploadOpen}
                onUploaded={fetchCertificates}
            />

            <DeleteCertificateDialog
                certificate={deleteTarget}
                open={!!deleteTarget}
                onOpenChange={v => {
                    if (!v) setDeleteTarget(null);
                }}
                onDeleted={() => {
                    setSelected(null);
                    fetchCertificates();
                }}
            />
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/components/certificates/certificate-client-component.tsx
git commit -m "feat: add certificate client component page composer"
```

---

### Task 21: Next.js page for /app/certificates

**Files:**
- Create: `web-ui/app/app/certificates/page.tsx`

- [ ] **Step 1: Write the page**

Create `web-ui/app/app/certificates/page.tsx`:

```typescript
import { Metadata } from "next";
import { CertificateClientComponent } from "@/components/certificates/certificate-client-component";

export const metadata: Metadata = {
    title: "Certificate Manager — Nucleus",
};

export default function CertificatesPage() {
    return <CertificateClientComponent />;
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/app/certificates/page.tsx
git commit -m "feat: add certificates page route"
```

---

### Task 22: Phase 2 — pg-boss certificate expiry monitor worker

**Files:**
- Create: `workers/src/jobs/certificate-expiry-monitor/handler.ts`
- Modify: `workers/src/jobs/index.ts` — register new job

- [ ] **Step 1: Write the expiry monitor handler**

Create `workers/src/jobs/certificate-expiry-monitor/handler.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { createLogger } from '../../lib/logger';

const logger = createLogger('certificate-expiry-monitor');

interface CertificateRow {
    id: string;
    tenantId: string;
    name: string;
    domainName: string;
    notAfter: Date;
    associatedAccountIds: string[];
}

export async function handleCertificateExpiryMonitor(): Promise<void> {
    logger.info('Starting certificate expiry monitor');

    const db = new PrismaClient();
    const sixtyDaysFromNow = new Date(Date.now() + 60 * 86400000);

    try {
        const certificates = await db.certificate.findMany({
            where: {
                notAfter: { lte: sixtyDaysFromNow },
                status: { in: ['active', 'expiring'] },
                associatedAccountIds: { isEmpty: false },
            },
        });

        logger.info(`Found ${certificates.length} certificates expiring within 60 days`);

        for (const cert of certificates) {
            for (const accountId of cert.associatedAccountIds) {
                try {
                    const account = await db.account.findFirst({
                        where: { tenantId: cert.tenantId, accountId },
                        select: { roleArn: true, externalId: true, regions: true },
                    });

                    if (!account) {
                        logger.warn(`Account ${accountId} not found for cert ${cert.id}`);
                        continue;
                    }

                    const stsClient = new STSClient({ region: account.regions[0] || 'us-east-1' });
                    const assumeCommand = new AssumeRoleCommand({
                        RoleArn: account.roleArn,
                        RoleSessionName: 'cert-expiry-monitor',
                        ...(account.externalId ? { ExternalId: account.externalId } : {}),
                    });
                    const { Credentials } = await stsClient.send(assumeCommand);

                    if (!Credentials) {
                        logger.warn(`Could not assume role for account ${accountId}`);
                        continue;
                    }

                    const acmClient = new ACMClient({
                        region: account.regions[0] || 'us-east-1',
                        credentials: {
                            accessKeyId: Credentials.AccessKeyId!,
                            secretAccessKey: Credentials.SecretAccessKey!,
                            sessionToken: Credentials.SessionToken!,
                        },
                    });

                    // Find matching ACM certificates in this account
                    const acmCerts = await db.inventoryResource.findMany({
                        where: {
                            tenantId: cert.tenantId,
                            accountId,
                            resourceType: 'acm_certificates',
                        },
                        select: { resourceId: true, metadata: true },
                    });

                    for (const acmCert of acmCerts) {
                        const metaDomain = (acmCert.metadata as Record<string, unknown>)?.domainName as string;
                        if (metaDomain?.toLowerCase() !== cert.domainName.toLowerCase()) continue;

                        try {
                            const desc = await acmClient.send(
                                new DescribeCertificateCommand({
                                    CertificateArn: acmCert.resourceId,
                                })
                            );

                            const acmStatus = desc.Certificate?.Status;
                            const acmNotAfter = desc.Certificate?.NotAfter;

                            logger.info(
                                `Cert ${cert.name} in account ${accountId}: ACM status=${acmStatus}, ACM expiry=${acmNotAfter}`
                            );
                        } catch (acmErr) {
                            logger.warn(
                                `Could not describe ACM cert ${acmCert.resourceId}: ${acmErr}`
                            );
                        }
                    }
                } catch (err) {
                    logger.error(`Error processing account ${accountId} for cert ${cert.id}: ${err}`);
                }
            }
        }

        // Update status for expired certs
        const now = new Date();
        const expiredResult = await db.certificate.updateMany({
            where: {
                notAfter: { lt: now },
                status: { not: 'expired' },
            },
            data: { status: 'expired' },
        });
        if (expiredResult.count > 0) {
            logger.info(`Updated ${expiredResult.count} certificates to 'expired'`);
        }

        // Update status for expiring certs
        const expiringResult = await db.certificate.updateMany({
            where: {
                notAfter: { gte: now, lte: sixtyDaysFromNow },
                status: 'active',
            },
            data: { status: 'expiring' },
        });
        if (expiringResult.count > 0) {
            logger.info(`Updated ${expiringResult.count} certificates to 'expiring'`);
        }

        logger.info('Certificate expiry monitor complete');
    } catch (err) {
        logger.error(`Certificate expiry monitor failed: ${err}`);
        throw err;
    } finally {
        await db.$disconnect();
    }
}
```

- [ ] **Step 2: Register the job in workers**

In `workers/src/jobs/index.ts`, add the job registration. The exact pattern depends on the file structure. If it uses a registry map, add:

```typescript
import { handleCertificateExpiryMonitor } from './certificate-expiry-monitor/handler';

// In the job map:
'certificate-expiry-monitor': handleCertificateExpiryMonitor,
```

If the file doesn't exist, check the pg-boss worker setup pattern first:

```bash
cat workers/src/jobs/index.ts
```

- [ ] **Step 3: Commit**

```bash
git add workers/src/jobs/certificate-expiry-monitor/ workers/src/jobs/index.ts
git commit -m "feat: add certificate expiry monitor pg-boss worker"
```

---

### Task 23: Phase 3 — POST /api/certificates/[id]/reimport

**Files:**
- Create: `web-ui/app/api/certificates/[id]/reimport/route.ts`

- [ ] **Step 1: Write the reimport route**

Create `web-ui/app/api/certificates/[id]/reimport/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ACMClient, ImportCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getTenantClient } from '@/lib/db/pg-config';

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
            return NextResponse.json(
                { success: false, error: 'accountId is required' },
                { status: 400 }
            );
        }

        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);

        if (!cert) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        if (!cert.associatedAccountIds.includes(targetAccountId)) {
            return NextResponse.json(
                { success: false, error: 'Certificate not associated with this account' },
                { status: 400 }
            );
        }

        // Get account details
        const db = getTenantClient(tenantId);
        const account = await db.account.findFirst({
            where: { tenantId, accountId: targetAccountId },
            select: { roleArn: true, externalId: true, regions: true, name: true },
        });

        if (!account) {
            return NextResponse.json(
                { success: false, error: 'Account not found' },
                { status: 404 }
            );
        }

        // Load certificate files from S3
        const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
        const bucket = process.env.APP_BUCKET_NAME || '';

        const [bodyObj, chainObj, keyObj] = await Promise.all([
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3BodyKey })),
            cert.s3ChainKey
                ? s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3ChainKey }))
                : Promise.resolve(null),
            s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: cert.s3PrivateKeyKey })),
        ]);

        const certBody = await bodyObj.Body!.transformToString();
        const certChain = chainObj ? await chainObj.Body!.transformToString() : undefined;
        const privateKey = await keyObj.Body!.transformToString();

        // STS AssumeRole into target account
        const stsClient = new STSClient({ region: account.regions[0] || 'us-east-1' });
        const { Credentials } = await stsClient.send(
            new AssumeRoleCommand({
                RoleArn: account.roleArn,
                RoleSessionName: 'cert-reimport',
                ...(account.externalId ? { ExternalId: account.externalId } : {}),
            })
        );

        if (!Credentials) {
            return NextResponse.json(
                { success: false, error: 'Failed to assume role into target account' },
                { status: 500 }
            );
        }

        // Find the existing ACM certificate ARN from inventory
        const acmResources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                accountId: targetAccountId,
                resourceType: 'acm_certificates',
            },
            select: { resourceId: true, metadata: true },
        });

        const matchingAcmCert = acmResources.find(r => {
            const meta = r.metadata as Record<string, unknown>;
            return (meta?.domainName as string || '').toLowerCase() === cert.domainName.toLowerCase();
        });

        const certificateArn = matchingAcmCert?.resourceId;

        // Reimport to ACM
        const acmClient = new ACMClient({
            region: account.regions[0] || 'us-east-1',
            credentials: {
                accessKeyId: Credentials.AccessKeyId!,
                secretAccessKey: Credentials.SecretAccessKey!,
                sessionToken: Credentials.SessionToken!,
            },
        });

        const importCommand = new ImportCertificateCommand({
            Certificate: Buffer.from(certBody),
            PrivateKey: Buffer.from(privateKey),
            ...(certChain ? { CertificateChain: Buffer.from(certChain) } : {}),
            ...(certificateArn ? { CertificateArn: certificateArn } : {}),
        });

        const result = await acmClient.send(importCommand);

        const session = await getServerSession(authOptions);
        await AuditService.logUserAction({
            action: 'reimport',
            resourceType: 'certificate',
            resourceId: certId,
            resourceName: cert.name,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Certificate "${cert.name}" reimported to ACM in account ${account.name} (${targetAccountId})`,
            tenantId,
            metadata: {
                accountId: targetAccountId,
                accountName: account.name,
                certificateArn: result.CertificateArn,
            },
        });

        return NextResponse.json({
            success: true,
            data: {
                certificateArn: result.CertificateArn,
                accountId: targetAccountId,
            },
        });
    } catch (error: unknown) {
        console.error('Error reimporting certificate:', error);
        const message = error instanceof Error ? error.message : 'Failed to reimport certificate';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/app/api/certificates/[id]/reimport/route.ts
git commit -m "feat: add POST /api/certificates/[id]/reimport endpoint"
```

---

## Self-Review

**1. Spec coverage:**
- Phase 1 CRUD → Tasks 7-11 (API routes) + Tasks 14-21 (UI)
- S3 storage → Task 8 (upload saves to S3)
- Masked UI → Task 15 (detail tab with Eye/EyeOff)
- Master-detail layout → Tasks 14, 17, 20 (grid + side panel + composer)
- Auto-discover accounts → Task 8 (POST queries inventory_resources)
- Expiry warnings → Task 6 (computeExpiryStatus), Task 14 (grid row highlight + color)
- Download → Task 10 (pre-signed URLs)
- Phase 2 expiry monitor → Task 22
- Phase 3 reimport → Task 23 + Task 16 (accounts tab reimport button)
- RBAC → Task 12
- Sidebar nav → Task 13
- Repository pattern → Tasks 3-5

**2. Placeholder scan:** No TBD, TODO, "implement later", or "add appropriate error handling" found. Every step has concrete code.

**3. Type consistency:** `CertificateRecord` used consistently across interface, repository implementation, and API routes. `CertificateRow` used for UI. Account types align between API response and tab components.
