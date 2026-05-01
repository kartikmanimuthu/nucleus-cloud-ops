# Certificate Manager — Design Spec

## Overview

A certificate management feature similar to AWS ACM. Users upload certificates (body, chain, private key), store them securely in S3, view them in a master-detail UI with masked values, and reimport them into AWS ACM across associated accounts. Certificate Manager is the source of truth — all sync is unidirectional (S3 → ACM).

## Phases

| Phase | Scope |
|---|---|
| **Phase 1** | Certificate CRUD, S3 storage, masked UI, master-detail layout, auto-discover associated accounts from inventory, expiry warnings (60-day threshold), download |
| **Phase 2** | pg-boss expiry monitoring job — scans expiring certs, checks ACM status, updates UI indicators. No automatic reimport |
| **Phase 3** | Manual "Reimport" CTA per account — load cert from S3, STS AssumeRole, `acm.importCertificate()`, audit logged |
| **Phase 4** (future) | Notification table + Slack/email integration for expiring cert alerts |

## Data Model

New Prisma model — `Certificate` (standalone, not extending `inventory_resources`):

```prisma
model Certificate {
  id                   String   @id @default(cuid())
  tenantId             String
  name                 String
  domainName           String
  status               String   @default("active")   // active | expiring | expired
  issuer               String?
  notBefore            DateTime?
  notAfter             DateTime
  s3BodyKey            String                         // cert body PEM
  s3ChainKey           String?                        // cert chain PEM
  s3PrivateKeyKey      String                         // private key PEM
  associatedAccountIds String[] @default([])          // auto-discovered from inventory
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

No FK to accounts — association is by value matching on `accountId` (same pattern as `inventory_resources`). Tenant scoping via `getTenantClient(tenantId)` middleware.

### S3 Storage

- Bucket: `APP_BUCKET_NAME` env var
- Key pattern: `certificates/{tenantId}/{certId}/body.pem`, `chain.pem`, `private.key`
- Encryption: SSE-S3 (inherited from bucket config)
- Download: package as `.zip` (body.pem + chain.pem + private.key), return pre-signed URL (1 hour expiry)

## API Routes

All routes under `web-ui/app/api/certificates/`. Every mutating route calls `authorize()` for RBAC. Tenant extracted via `getSessionTenantId()`.

| Route | Method | Purpose |
|---|---|---|
| `/api/certificates` | GET | List certs (paginated, sort by notAfter asc, filter by status) |
| `/api/certificates` | POST | Upload cert (text paste OR multipart files) |
| `/api/certificates/[id]` | GET | Single cert with resolved account details |
| `/api/certificates/[id]` | DELETE | Delete cert + S3 objects + audit log |
| `/api/certificates/[id]/download` | GET | Build zip from S3, return pre-signed URL |
| `/api/certificates/[id]/accounts` | GET | Associated accounts with resources from inventory |
| `/api/certificates/[id]/reimport` | POST | Reimport to AWS ACM for specified account(s) |

### Upload Flow

1. Accept `name`, `domainName`, `body`, `chain` (optional), `privateKey` — as text fields or multipart files
2. Validate PEM format on body and privateKey (must not be empty)
3. Parse certificate body to extract `notBefore`, `notAfter`, `issuer`, subject CN/SANs
4. Upload all 3 parts to S3 under `certificates/{tenantId}/{certId}/`
5. Query `inventory_resources` for `resourceType = 'acm_certificates'` where metadata `domainName` matches — auto-populate `associatedAccountIds`
6. Set `status` based on `notAfter`: `expired` if past, `expiring` if <60 days, `active` otherwise
7. Audit log the upload

### Reimport Flow (Phase 3)

1. Load cert body, chain, private key from S3
2. For the target account: resolve `roleArn` from `accounts` table, STS AssumeRole
3. Call `acm.describeCertificate()` to find the existing ACM cert ARN (from inventory metadata)
4. Call `acm.importCertificate(Certificate, PrivateKey, CertificateChain, CertificateArn)` to reimport
5. Audit log with `eventType: 'certificate.reimport'`, account details, and result
6. Return `{ success: true, certificateArn, accountId }` or `{ success: false, error }`

## UI Design

### Layout: Master-Detail Split

**Left Panel — Certificate Grid**
- TanStack Table (`ResourceGrid` pattern from `components/inventory/resource-grid.tsx`)
- Columns: Name, Domain (masked), Status (Badge), Expiry (color-coded date), Accounts (count badge), Issuer, Actions (Download, Delete)
- Sorted by `notAfter` ascending (expiring soonest at top)
- Row highlight: amber/warning background for certs expiring within 60 days
- Domain masking: `***.example.com` display format

**Right Panel — Side Panel (slides in on row click)**
- Tab 1: **Certificate Details** — domain, issuer, validity period, SANs. Certificate body in `<pre>` block masked as `****` by default, with Eye/EyeOff toggle to reveal. Same for private key
- Tab 2: **Associated Accounts** (`N`) — table of accounts from auto-discovery. Columns: Account Name, Account ID, Region, ACM Status. Per-row "Reimport" CTA button (Phase 3). Empty state: "No associated accounts found"
- Tab 3: **Associated Resources** (`N`) — table of resources from inventory. Columns: Resource Type, Resource Name, Region

### Component Structure

```
web-ui/components/certificates/
  certificate-grid.tsx               // TanStack Table — left panel
  certificate-side-panel.tsx         // Right side panel container (Tabs)
  certificate-detail-tab.tsx         // Detail + masked cert body
  certificate-accounts-tab.tsx       // Associated accounts table + reimport CTA
  certificate-resources-tab.tsx      // Associated resources table
  upload-certificate-dialog.tsx      // Upload form (paste + file)
  delete-certificate-dialog.tsx      // Delete confirmation
  certificate-client-component.tsx   // Page-level composer
```

### Navigation

Add entry to `navigation` array in `sidebar.tsx`:
```typescript
{ name: "Certificate Manager", href: "/app/certificates", icon: ShieldCheck }
```

### Masking Pattern

Follow existing pattern from `channels/slack-settings-form.tsx`:
- `useState(false)` boolean per sensitive field
- Conditional render: `show ? <pre>{certBody}</pre> : <pre>{"*".repeat(80)}</pre>`
- Eye/EyeOff toggle button from lucide-react
- Apply to: certificate body, private key (chain can be shown plain since it's public)

### Expiry Warning

- Row-level: amber background when `notAfter` is within 60 days from now
- Date column: red text if <30 days, yellow if <60 days, muted otherwise (follows existing `ACM_COLS` pattern in `column-registry.tsx` lines 1002-1014)
- Phase 2: additional "ACM also expiring" badge when the job detects ACM side is expiring too

## Phase 2 — Expiry Monitoring Worker

Location: `workers/src/jobs/certificate-expiry-monitor/`

### Flow

1. Cron: daily (default 6am, configurable per tenant)
2. Query `certificates` where `notAfter` is within 60 days AND `associatedAccountIds` is non-empty
3. For each cert: for each associated account, STS AssumeRole → `acm.describeCertificate()` to check ACM-side status
4. Update certificate record with ACM status metadata
5. UI reflects ACM status: "ACM cert also expiring — needs reimport" indicator

### What it does NOT do

- No automatic reimport (all reimports are manual CTA from UI)
- No bidirectional sync (Certificate Manager is source of truth)
- No notifications (deferred to Phase 4)

## Repository Pattern

Interface: `web-ui/lib/db/repositories/certificate/interface.ts`
Implementation: `web-ui/lib/db/repositories/certificate/postgres.ts`
Registered in: `web-ui/lib/db/repository-factory.ts`

## Security

- Private key stored in S3 with SSE-S3 encryption
- UI masking by default for cert body and private key
- RBAC: `authorize('read'/'create'/'delete', 'Certificate')` on all routes
- STS AssumeRole with external ID for cross-account ACM operations
- All reimport actions audit logged
- Pre-signed URLs for download (1-hour expiry, scoped to specific object)

## Testing

- Unit tests (Vitest): certificate repository, PEM parsing, expiry status logic
- API tests: CRUD endpoints, upload validation, reimport flow
- UI component tests: grid rendering, masking toggle, side panel tabs
- Worker tests: expiry monitor job logic
