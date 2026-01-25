'use client';

import { SessionProvider } from 'next-auth/react';
import { ReactNode } from 'react';
import { AbilityProvider } from '@/lib/rbac/AbilityContext';

interface RBACProviderProps {
  children: ReactNode;
  roles: string[];
  tenantId?: string;
}

/**
 * Combined provider for session and RBAC.
 * This wraps children with both NextAuth SessionProvider and CASL AbilityProvider.
 */
export function RBACProvider({ children, roles, tenantId }: RBACProviderProps) {
  return (
    <AbilityProvider roles={roles} tenantId={tenantId}>
      {children}
    </AbilityProvider>
  );
}

/**
 * Server component wrapper to fetch roles and provide them to client.
 * Use this in layouts where you need RBAC context.
 */
export { AbilityProvider } from '@/lib/rbac/AbilityContext';
