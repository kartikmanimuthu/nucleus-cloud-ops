import { SearchParams } from "@/lib/types";
import AuditClient from "@/components/audit/audit-client-component";

/**
 * Thin server shell — all data fetching happens client-side via API routes
 * so that pagination tokens and filter state are managed consistently.
 */
export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const initialFilters = {
    eventType: params.eventType ? String(params.eventType) : undefined,
    status: params.status ? String(params.status) : undefined,
    user: params.user ? String(params.user) : undefined,
    startDate: params.startDate ? String(params.startDate) : undefined,
    endDate: params.endDate ? String(params.endDate) : undefined,
  };

  return <AuditClient initialFilters={initialFilters} />;
}
