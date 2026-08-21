import { redirect } from 'next/navigation';
import { can } from '@/lib/rbac/authorize';

interface AuthorizePageProps {
  action: string;
  subject: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Server component wrapper that checks authorization before rendering children.
 * If user lacks permission, redirects to /unauthorized page.
 *
 * @example
 * <AuthorizePage action="read" subject="Account">
 *   <AccountsPage />
 * </AuthorizePage>
 */
export async function AuthorizePage({
  action,
  subject,
  children,
  fallback,
}: AuthorizePageProps) {
  const allowed = await can(action, subject);

  if (!allowed) {
    if (fallback) {
      return <>{fallback}</>;
    }
    redirect('/app/unauthorized');
  }

  return <>{children}</>;
}

/**
 * Helper function to check authorization in server components.
 * Returns true if authorized, false otherwise.
 */
export async function checkPageAuth(action: string, subject: string): Promise<boolean> {
  return can(action, subject);
}

/**
 * Redirect to unauthorized if user cannot perform action.
 * Use this in page components or layouts.
 */
export async function requireAuth(action: string, subject: string): Promise<void> {
  const allowed = await can(action, subject);
  if (!allowed) {
    redirect('/app/unauthorized');
  }
}
