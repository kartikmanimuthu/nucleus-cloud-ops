import { NextResponse } from 'next/server';
import { getServerAbility } from './server-ability';
import { Actions, Subjects } from './types';
import { subject } from '@casl/ability';

/**
 * Authorization helper for API routes.
 * Returns a NextResponse error if unauthorized, or null if authorized.
 * 
 * @param action - The action being performed (create, read, update, delete, etc.)
 * @param subjectType - The resource type being accessed
 * @param subjectData - Optional subject data for ABAC (attribute-based) checks
 * @returns NextResponse with 403 error if unauthorized, null if authorized
 * 
 * @example
 * // In an API route
 * export async function DELETE(request: Request) {
 *   const authError = await authorize('delete', 'Schedule');
 *   if (authError) return authError;
 *   
 *   // Proceed with delete logic...
 * }
 */
export async function authorize(
    action: Actions,
    subjectType: Subjects,
    subjectData?: Record<string, any>
): Promise<NextResponse | null> {
    const ability = await getServerAbility();

    // Check permission with optional ABAC conditions
    const canPerform = subjectData
        ? ability.can(action, subject(subjectType, subjectData) as any)
        : ability.can(action, subjectType);

    if (!canPerform) {
        return NextResponse.json(
            {
                error: 'Forbidden',
                message: `You do not have permission to ${action} ${subjectType}`,
                action,
                subject: subjectType,
            },
            { status: 403 }
        );
    }

    return null; // Authorized
}

/**
 * Check if the current user has admin privileges.
 * 
 * @returns true if user can manage all resources
 */
export async function isAdmin(): Promise<boolean> {
    const ability = await getServerAbility();
    return ability.can('manage', 'all');
}

/**
 * Check if the current user can perform an action on a subject.
 * 
 * @param action - The action to check
 * @param subjectType - The subject type
 * @returns true if the user has permission
 */
export async function can(action: Actions, subjectType: Subjects): Promise<boolean> {
    const ability = await getServerAbility();
    return ability.can(action, subjectType);
}

/**
 * Check if the current user cannot perform an action on a subject.
 * 
 * @param action - The action to check  
 * @param subjectType - The subject type
 * @returns true if the user does NOT have permission
 */
export async function cannot(action: Actions, subjectType: Subjects): Promise<boolean> {
    const ability = await getServerAbility();
    return ability.cannot(action, subjectType);
}
