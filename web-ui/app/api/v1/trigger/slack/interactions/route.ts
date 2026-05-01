import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

// Backward-compat redirect — Slack interactivity URL may still point here.
// Remove once Slack app config is updated to /api/v1/gateway/slack/interactions.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
