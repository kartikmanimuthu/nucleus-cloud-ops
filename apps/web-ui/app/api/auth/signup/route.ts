import { NextRequest, NextResponse } from "next/server";
import { getPrismaClient } from "@/lib/db/pg-config";
import { AuditService } from '@/lib/audit-service';
import bcrypt from "bcryptjs";
import { z } from "zod";

const signupSchema = z.object({
    email: z.string().email("Please enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const parsed = signupSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            );
        }

        const { email, password } = parsed.data;
        const prisma = getPrismaClient();

        // Check for existing user
        const existing = await prisma.authUser.findUnique({ where: { email } });
        if (existing) {
            return NextResponse.json(
                { error: "An account with this email already exists. Sign in instead." },
                { status: 409 }
            );
        }

        // Hash password — same salt rounds as CredentialsProvider in auth-options.ts
        const passwordHash = await bcrypt.hash(password, 12);

        // Create AuthUser — no tenantId yet; user creates org after first login
        const user = await prisma.authUser.create({
            data: {
                email,
                passwordHash,
                isSuperAdmin: false,
            },
        });

        console.log(`API - POST /api/auth/signup - Created user ${user.id}`);

        // Audit: log successful signup
        AuditService.logUserAction({
            eventType: 'auth.signup.created',
            severity: 'medium',
            apiRoute: 'POST /api/auth/signup',
            httpMethod: 'POST',
            action: 'auth.signup.created',
            resourceType: 'auth',
            resourceId: user.id,
            resourceName: 'User Signup',
            user: email,
            userType: 'user',
            status: 'success',
            details: `New user account created for ${email}`,
            metadata: { tenantId: 'unknown' },
        }).catch(() => {});

        return NextResponse.json(
            { success: true, userId: user.id },
            { status: 201 }
        );
    } catch (error) {
        console.error("API - POST /api/auth/signup - Error:", error);
        return NextResponse.json(
            { error: "Something went wrong. Please try again." },
            { status: 500 }
        );
    }
}
