import 'next-auth';

declare module 'next-auth' {
    interface Session {
        accessToken?: string;
        user: {
            name?: string | null;
            email?: string | null;
            image?: string | null;
            groups?: string[];
        }
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        groups?: string[];
    }
}
