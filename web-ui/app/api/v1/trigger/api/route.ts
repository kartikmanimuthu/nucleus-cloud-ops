import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

// Backward-compat redirect — API clients may still use this path.
// Remove once all clients are updated to /api/v1/gateway/api.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('api', req);
}
