'use client';

import { createContext, useContext, ReactNode } from 'react';
import { createContextualCan, useAbility as useCaslAbility } from '@casl/react';
import { AppAbility } from './types';
import { defineAbilitiesFor } from './abilities';

// Default empty ability for fallback
const defaultAbility = defineAbilitiesFor([]);

// Create the Ability Context with default value
export const AbilityContext = createContext<AppAbility>(defaultAbility);

// Create a contextual Can component for declarative permission checks
// Usage: <Can I="update" a="Schedule">...</Can>
export const Can = createContextualCan(AbilityContext.Consumer);

/**
 * Hook to use ability in components for imperative permission checks.
 * 
 * @example
 * const ability = useAbility();
 * if (ability.can('delete', 'Schedule')) { ... }
 */
export function useAbility(): AppAbility {
  return useContext(AbilityContext);
}

/**
 * Hook to check a specific permission.
 * 
 * @example
 * const canDelete = usePermission('delete', 'Schedule');
 */
export function usePermission(action: string, subject: string): boolean {
  const ability = useAbility();
  return ability.can(action as any, subject as any);
}

// Ability Provider Props
interface AbilityProviderProps {
  children: ReactNode;
  roles: string[];
  tenantId?: string;
}

/**
 * AbilityProvider component that provides CASL abilities to the component tree.
 * 
 * @example
 * <AbilityProvider roles={['TenantAdmin']} tenantId="tenant-123">
 *   <App />
 * </AbilityProvider>
 */
export function AbilityProvider({ children, roles, tenantId }: AbilityProviderProps) {
  const ability = defineAbilitiesFor(roles, tenantId);
  
  return (
    <AbilityContext.Provider value={ability}>
      {children}
    </AbilityContext.Provider>
  );
}
