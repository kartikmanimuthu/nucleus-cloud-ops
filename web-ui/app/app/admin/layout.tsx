import { Metadata } from 'next';
import { isAdmin } from '@/lib/rbac/authorize';
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
  // Check if user has admin permissions (Owner or Admin role)
  const admin = await isAdmin();

  if (!admin) {
    redirect('/app/dashboard');
  }

  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  );
}
