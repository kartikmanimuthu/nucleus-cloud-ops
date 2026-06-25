import { AccountService } from "@/lib/account-service";
import { UIAccount } from "@/lib/types";
import AccountsClient from "@/components/accounts/accounts-client-component";
import { SearchParams } from "@/lib/types";

// Status and connection filter options for the UI
const statusFilters = [
  { value: "all", label: "All Accounts" },
  { value: "active", label: "Active Only" },
  { value: "inactive", label: "Inactive Only" },
];

const connectionFilters = [
  { value: "all", label: "All Connections" },
  { value: "connected", label: "Connected" },
  { value: "error", label: "Connection Error" },
  { value: "warning", label: "Warning" },
  { value: "validating", label: "Validating" },
];

/**
 * Server component that fetches accounts data from DynamoDB
 */
export default async function AccountsPage({ searchParams}: { searchParams: SearchParams }) {
  const resolvedSearchParams = await searchParams;
  const statusFilter = typeof resolvedSearchParams.status === 'string' ? resolvedSearchParams.status : 'all';
  const connectionFilter = typeof resolvedSearchParams.connection === 'string' ? resolvedSearchParams.connection : 'all';
  const searchTerm = typeof resolvedSearchParams.search === 'string' ? resolvedSearchParams.search : '';
  const page = typeof resolvedSearchParams.page === 'string' ? parseInt(resolvedSearchParams.page) : 1;
  const limit = typeof resolvedSearchParams.limit === 'string' ? parseInt(resolvedSearchParams.limit) : 10;
  
  // Fetch filtered accounts from DynamoDB on the server side with limit
  const result = await getAccounts({
    statusFilter,
    connectionFilter,
    searchTerm,
    limit,
    page
  });
  
  // Pass the pre-fetched data and initial filter states to the client component
  return <AccountsClient 
    initialAccounts={result.accounts}
    initialFilters={{
      statusFilter,
      connectionFilter,
      searchTerm
    }} 
    initialPagination={{
        page,
        limit,
        total: result.totalCount || 0
    }}
    statusFilters={statusFilters} 
    connectionFilters={connectionFilters} 
  />;
}

/**
 * Server-side function to fetch accounts from DynamoDB
 */
async function getAccounts(filters?: {
  statusFilter?: string;
  connectionFilter?: string;
  searchTerm?: string;
  limit?: number;
  page?: number;
}): Promise<{ accounts: UIAccount[], totalCount: number }> {
  try {
    const result = await AccountService.getAccounts(filters);
    return result;
  } catch (error) {
    console.error('Server-side: Error loading accounts from DynamoDB:', error);
    return { accounts: [], totalCount: 0 };
  }
}

