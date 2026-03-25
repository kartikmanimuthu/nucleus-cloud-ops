import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function SchedulesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Require read access to Schedule to view this section
  await requireAuth('read', 'Schedule');
  
  return <>{children}</>;
}
