import "next-auth";

declare module "next-auth" {
    interface Session {
        user: {
            id: string;
            email: string;
            tenantId: string | null;
            role: string | null;
            isSuperAdmin: boolean;
        };
    }

    interface User {
        id: string;
        email: string;
        passwordHash?: string | null;
        isSuperAdmin: boolean;
        failedAttempts: number;
        lockedUntil: Date | null;
    }
}

declare module "next-auth/adapters" {
    interface AdapterUser {
        id: string;
        email: string;
        passwordHash?: string | null;
        isSuperAdmin: boolean;
        failedAttempts: number;
        lockedUntil: Date | null;
    }
}
