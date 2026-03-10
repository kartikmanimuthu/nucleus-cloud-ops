import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';

export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const url = new URL(req.url);
        const tenantId = url.searchParams.get('tenantId') || 'default';
        const limit = parseInt(url.searchParams.get('limit') || '25', 10);

        const { runs } = await agentOpsService.listRuns({ tenantId, source: 'scheduled', limit });
        const taskRuns = runs.filter(r => (r.trigger as any)?.taskId === taskId);
        return NextResponse.json({ runs: taskRuns });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
