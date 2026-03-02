import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";

/**
 * Resolves the authenticated user ID from NextAuth/Cognito session.
 * Returns `USER#<cognito-sub>` format (consistent with users-teams table PK).
 * Throws if no authenticated session — callers should catch and return 401.
 */
export async function getSessionUserId(): Promise<string> {
    const session = await getServerSession(authOptions);
    const sub = (session?.user as any)?.sub ?? session?.user?.email;
    if (!sub) {
        throw new Error("Unauthenticated: no valid session");
    }
    return `USER#${sub}`;
}
