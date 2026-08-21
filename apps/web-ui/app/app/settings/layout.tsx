import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /**
   * `Tenant` — the "Organization" row under Settings (that is the seeded label,
   * dynamic_abac:473). A layout-level check is per-submodule here, unlike the IAM
   * one, because both real pages under this directory ARE that submodule:
   * /app/settings (Overview) and /app/settings/organization both read and write
   * tenant settings via /api/tenants/settings, which enforces update/Tenant.
   *
   * It required read/'Account' — the AWS Accounts subject — so a role granted
   * Settings in full was redirected to /app/unauthorized on both. Same defect
   * app/app/agent-ops/providers/page.tsx:62 documents escaping by relocating the
   * page. The old comment claimed this enforced "at least TenantOperator level
   * access"; it did not — requireAuth is a permission check, not a level check,
   * and the permission it named was the wrong one.
   *
   * KNOWN, ACCEPTED: the three legacy redirect stubs in here
   * (settings/members, settings/roles, settings/access-control → /app/iam/*)
   * pass through this check too, so an IAM-only role following an old bookmark
   * is denied instead of redirected. The layout cannot tell them apart, and the
   * live nav has pointed at /app/iam/* since those moved.
   *
   * Certificates is NOT affected: it lives at /app/certificates, outside this
   * layout, and owns its own `Certificate` subject.
   */
  await requireAuth('read', 'Tenant');


  return <>{children}</>;
}
