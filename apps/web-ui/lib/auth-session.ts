import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth-options";
import "@/lib/auth-types";

/**
 * Get the full authenticated session. Returns null if not authenticated.
 */
export async function getAuthSession() {
    return getServerSession(authOptions);
}

/**
 * Extract tenantId from session. Returns the tenantId string.
 * Throws if no session or tenantId is missing — callers should catch and return 401.
 */
export async function getSessionTenantId(): Promise<string> {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        throw new Error("Unauthenticated: no valid session");
    }
    if (!session.user.tenantId) {
        throw new Error("Unauthorized: no tenant associated with session");
    }
    return session.user.tenantId;
}

/**
 * Extract userId from session. Returns USER#id format for backward compatibility.
 * Throws if no session — callers should catch and return 401.
 */
export async function getSessionUserId(): Promise<string> {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        throw new Error("Unauthenticated: no valid session");
    }
    return `USER#${session.user.id}`;
}

/**
 * Assert the current user is a super admin.
 * Returns null if authorized, or a NextResponse with 401/403 if not.
 */
export async function assertSuperAdmin(): Promise<NextResponse | null> {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json(
            { error: "Unauthenticated", message: "No valid session" },
            { status: 401 }
        );
    }
    if (session.user.isSuperAdmin !== true) {
        return NextResponse.json(
            { error: "Forbidden", message: "Super admin access required" },
            { status: 403 }
        );
    }
    return null; // Authorized
}
