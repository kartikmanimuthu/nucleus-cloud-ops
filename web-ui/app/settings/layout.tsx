import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Settings requires at least TenantOperator level access
  await requireAuth('read', 'Account');
  
  return <>{children}</>;
}
