import { requireAuth } from '@/components/auth/AuthorizePage';

/**
 * Members is the `User` subject — the "Members" row under IAM (relabelled in
 * 20260812130000, because the sidebar has always called this page Members).
 *
 * The guard lives in a layout rather than the page because page.tsx is a client
 * component and requireAuth is server-only. Scoping it to this directory is what
 * makes it per-submodule: the parent IAM layout wraps Roles too, so a check up
 * there could only ever be the whole module.
 */
export default async function MembersLayout({ children }: { children: React.ReactNode }) {
  await requireAuth('read', 'User');

  return <>{children}</>;
}
