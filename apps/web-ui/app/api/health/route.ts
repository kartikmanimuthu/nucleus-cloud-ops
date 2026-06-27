import { NextResponse } from 'next/server';
import { getPrismaClient } from '@/lib/db/pg-config';
import { env } from '@/env';

interface HealthCheck {
    status: string;
    timestamp: string;
    service: string;
    environment: string;
    database?: string | { status: string; error: string };
}

export async function GET() {
    const healthCheck: HealthCheck = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'web-ui',
        environment: env.NODE_ENV || 'development',
    };

    try {
        const prisma = getPrismaClient();
        await prisma.$queryRaw`SELECT 1`;
        healthCheck.database = 'connected';

        return NextResponse.json(healthCheck, { status: 200 });
    } catch (error) {
        console.error('Health check failed:', error);
        healthCheck.status = 'degraded';
        healthCheck.database = {
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
        };
        return NextResponse.json(healthCheck, { status: 207 });
    }
}

export async function HEAD() {
    return new NextResponse(null, { status: 200 });
}
