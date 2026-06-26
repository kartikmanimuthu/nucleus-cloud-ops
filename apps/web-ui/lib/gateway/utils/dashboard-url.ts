// web-ui/lib/gateway/utils/dashboard-url.ts
const APP_BASE_URL = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';

export function buildDashboardRespondUrl(runId: string): string {
    return `${APP_BASE_URL}/app/agent-ops/${runId}/respond`;
}
