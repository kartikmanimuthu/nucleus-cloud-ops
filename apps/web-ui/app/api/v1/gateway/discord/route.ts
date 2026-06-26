import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('discord', req);
}
