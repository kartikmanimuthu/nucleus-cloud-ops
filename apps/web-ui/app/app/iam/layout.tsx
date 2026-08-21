/**
 * No guard here, deliberately.
 *
 * This layout wraps two pages that belong to two DIFFERENT submodules —
 * /app/iam/members is the `User` subject ("Members") and /app/iam/roles is
 * `Role` — so any single check here is either too coarse (the IAM module, which
 * lets a Members-only role reach Roles) or simply wrong for one of them. It
 * previously required read/'Account', the AWS Accounts subject, which denied
 * both pages to a role granted IAM in full.
 *
 * Each page now carries its own check against its own submodule:
 *   · members/layout.tsx  -> read/User   (the page is a client component, so the
 *                                        guard needs a server boundary of its own)
 *   · roles/page.tsx      -> read/Role
 *
 * The two remaining routes under here — /app/iam/modules and
 * /app/iam/permissions — are redirect stubs to /app/iam/roles and render
 * nothing, so they are covered by the guard on their destination.
 */
export default function IamLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
