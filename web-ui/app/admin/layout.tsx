import { Metadata } from 'next';
import { getServerAbility } from '@/lib/rbac/server-ability';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Admin | Nucleus',
  description: 'Admin dashboard for Nucleus platform',
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Check if user has admin permissions
  const ability = await getServerAbility();
  
  // Must be able to read users to access admin section
  if (ability.cannot('read', 'User')) {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  );
}
