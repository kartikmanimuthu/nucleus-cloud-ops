import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
