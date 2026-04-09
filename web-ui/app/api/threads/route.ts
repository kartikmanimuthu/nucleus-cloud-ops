import { NextResponse } from 'next/server';
import { getSessionUserId, getSessionTenantId } from '@/lib/auth-session';

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
    ownerUserId?: string;
}

export async function GET() {
    try {
        let tenantId: string;
        let userId: string;
        try {
            tenantId = await getSessionTenantId();
            userId = await getSessionUserId();
        } catch {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        return NextResponse.json(await threadStore.listThreads(tenantId));
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch threads' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { id, title, model } = await req.json();
        if (!id) return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 });

        let tenantId: string;
        let userId: string;
        try {
            tenantId = await getSessionTenantId();
            userId = await getSessionUserId();
        } catch {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Validate tenant ownership if thread ID is namespaced
        if (id.includes(':')) {
            const [embeddedTenantId] = id.split(':');
            if (embeddedTenantId !== tenantId) {
                return NextResponse.json({ error: 'Forbidden: thread belongs to another tenant' }, { status: 403 });
            }
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        return NextResponse.json(await threadStore.createThread(id, title, model, tenantId, userId));
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create thread' }, { status: 500 });
    }
}
