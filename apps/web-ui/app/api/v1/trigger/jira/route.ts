import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

// Backward-compat redirect — Jira webhook URLs may still point here.
// Remove once all Jira automation rules are updated to /api/v1/gateway/jira.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('jira', req);
}
