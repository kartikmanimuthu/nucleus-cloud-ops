import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

// Backward-compat redirect — Slack slash command URLs may still point here.
// Remove once all Slack app configs are updated to /api/v1/gateway/slack.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
