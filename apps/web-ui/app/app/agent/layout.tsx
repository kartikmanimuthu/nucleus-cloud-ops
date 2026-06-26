import { requireAuth } from '@/components/auth/AuthorizePage';

export default async function AgentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Require read access to Agent to use AI Agent
  await requireAuth('read', 'Agent');
  
  return <>{children}</>;
}
