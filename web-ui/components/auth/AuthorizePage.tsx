import { redirect } from 'next/navigation';
import { getServerAbility } from '@/lib/rbac/server-ability';
import { Actions, Subjects } from '@/lib/rbac/types';

interface AuthorizePageProps {
  action: Actions;
  subject: Subjects;
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
  fallback 
}: AuthorizePageProps) {
  const ability = await getServerAbility();
  
  if (ability.cannot(action, subject)) {
    if (fallback) {
      return <>{fallback}</>;
    }
    redirect('/unauthorized');
  }

  return <>{children}</>;
}

/**
 * Helper function to check authorization in server components.
 * Returns true if authorized, false otherwise.
 */
export async function checkPageAuth(action: Actions, subject: Subjects): Promise<boolean> {
  const ability = await getServerAbility();
  return ability.can(action, subject);
}

/**
 * Redirect to unauthorized if user cannot perform action.
 * Use this in page components or layouts.
 */
export async function requireAuth(action: Actions, subject: Subjects): Promise<void> {
  const ability = await getServerAbility();
  if (ability.cannot(action, subject)) {
    redirect('/unauthorized');
  }
}
