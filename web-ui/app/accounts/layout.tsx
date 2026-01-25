import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function AccountsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Require read access to Account to view this section
  await requireAuth('read', 'Account');
  
  return <>{children}</>;
}
