import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function AuditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Require read access to AuditLog to view this section
  await requireAuth('read', 'AuditLog');
  
  return <>{children}</>;
}
