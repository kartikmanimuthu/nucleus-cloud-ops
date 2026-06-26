"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Server,
  Plus,
  RefreshCw,
  Globe,
  Shield,
  Loader2,
  AlertCircle,
  Power,
  PowerOff,
  CheckCircle,
} from "lucide-react";
import { AccountsTable } from "@/components/accounts/accounts-table";
import { AccountsGrid } from "@/components/accounts/accounts-grid";
import { ImportAccountsDialog } from "@/components/accounts/import-accounts-dialog";
import { BulkActionBar } from "@/components/shared/bulk-action-bar";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import type { BulkAction, BulkActionResult } from "@/lib/bulk-actions/types";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { useIsFirstRender } from "@/hooks/use-first-render";
import { PaginationBar } from "@/components/ui/pagination-bar";

const ACCOUNT_BULK_ACTIONS: BulkAction[] = [
  { key: "activate", label: "Activate", icon: Power },
  { key: "deactivate", label: "Deactivate", icon: PowerOff },
  { key: "validate", label: "Validate Connection", icon: CheckCircle },
];

interface FilterOption {
  value: string;
  label: string;
}

interface AccountsClientProps {
  initialAccounts: UIAccount[];
  initialFilters?: {
    statusFilter: string;
    connectionFilter: string;
    searchTerm: string;
  };
  initialPagination?: {
    page: number;
    limit: number;
    total: number;
  };
  statusFilters: FilterOption[];
  connectionFilters: FilterOption[];
}

/**
 * Client component that handles UI interactivity for the accounts page
 * Receives initial data from server component
 */
export default function AccountsClient({
  initialAccounts,
  initialFilters,
  initialPagination,
  statusFilters,
  connectionFilters,
}: AccountsClientProps) {
  const router = useRouter();
  const { toast } = useToast();

  // Data state
  const [accounts, setAccounts] = useState<UIAccount[]>(initialAccounts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalItems, setTotalItems] = useState(initialPagination?.total || initialAccounts.length);

  // Effective filters (used for fetching data)
  const [searchTerm, setSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [statusFilter, setStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [connectionFilter, setConnectionFilter] = useState(initialFilters?.connectionFilter || "all");

  // Pagination state
  const [currentPage, setCurrentPage] = useState(initialPagination?.page || 1);
  const [limit, setLimit] = useState(initialPagination?.limit || 10);

  // Local UI state for filters (pending application)
  const [localSearchTerm, setLocalSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [localStatusFilter, setLocalStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [localConnectionFilter, setLocalConnectionFilter] = useState(initialFilters?.connectionFilter || "all");

  const [viewMode, setViewMode] = useState<"table" | "grid">("grid");

  // Bulk selection
  const selection = useBulkSelection(accounts.map((a) => a.id));
  const [bulkLoading, setBulkLoading] = useState(false);

  // Stats state
  const [allAccounts, setAllAccounts] = useState<UIAccount[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Update URL with current filters and pagination
  const updateUrlWithFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (connectionFilter !== 'all') params.set('connection', connectionFilter);
    if (searchTerm) params.set('search', searchTerm);
    if (currentPage > 1) params.set('page', currentPage.toString());
    params.set('limit', limit.toString());
    
    // Replace the current URL with the new one including filters
    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
  }, [statusFilter, connectionFilter, searchTerm, currentPage, limit]);

  // Load accounts with current filters
  const loadAccountsWithFilters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      updateUrlWithFilters();

      const filters = {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        connectionFilter: connectionFilter !== 'all' ? connectionFilter : undefined,
        searchTerm: searchTerm || undefined,
        limit: limit,
        page: currentPage
      };
      
      const result = await ClientAccountService.getAccounts(filters);
      
      if (Array.isArray(result)) {
           setAccounts(result);
      } else {
           setAccounts(result.accounts);
           // Update total count if returned from API
           if (result.totalCount !== undefined) {
               setTotalItems(result.totalCount);
           }
      }
      
    } catch (err) {
      console.error("Error loading accounts:", err);
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, connectionFilter, searchTerm, currentPage, limit, updateUrlWithFilters]);

  // Load global stats (all accounts)
  const loadStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      // Fetch all accounts for stats (no limit, or high limit)
      const result = await ClientAccountService.getAccounts({ limit: 1000 });
      setAllAccounts(result.accounts);
    } catch (err) {
      console.error("Error loading stats:", err);
    } finally {
        setLoadingStats(false);
    }
  }, []);

  // Initial load for stats
  useEffect(() => {
     loadStats();
  }, [loadStats]);

  // Handle account updates
  const handleAccountUpdated = (message?: string) => {
    loadAccountsWithFilters();
    loadStats(); // Refresh stats
    if (message) {
      toast({
        variant: "success",
        title: "Success",
        description: message,
      });
    }
  };

  // Track if this is the first render
  const isFirstRender = useIsFirstRender();

  // Update URL and fetch data when EFFECTIVE filters change
  useEffect(() => {
    if (!isFirstRender) {
      loadAccountsWithFilters();
    }
  }, [searchTerm, statusFilter, connectionFilter, currentPage, limit, loadAccountsWithFilters, isFirstRender]);

  // Sync state with props when server re-renders
  useEffect(() => {
    setAccounts(initialAccounts);
    setTotalItems(initialPagination?.total || initialAccounts.length);
  }, [initialAccounts, initialPagination]);

  const refreshAccounts = () => {
    loadAccountsWithFilters();
  };

  const handleApplyFilter = () => {
    setSearchTerm(localSearchTerm);
    setStatusFilter(localStatusFilter);
    setConnectionFilter(localConnectionFilter);
    setCurrentPage(1); // Reset to first page
  };

  const handleClearFilter = () => {
    // Reset local state
    setLocalSearchTerm("");
    setLocalStatusFilter("all");
    setLocalConnectionFilter("all");
    
    // Reset effective state (triggers reload)
    setSearchTerm("");
    setStatusFilter("all");
    setConnectionFilter("all");
    setCurrentPage(1); // Reset to first page
  };

  // Run a bulk action against the selected accounts, then report + refresh.
  const handleBulkAction = async (action: string) => {
    const accountIds = selection.selectedIds;
    if (accountIds.length === 0) return;

    try {
      setBulkLoading(true);
      const res = await fetch("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, accountIds }),
      });
      const payload = await res.json();

      if (!res.ok || !payload.success) {
        throw new Error(payload.error || "Bulk action failed");
      }

      const result = payload.data as BulkActionResult;
      const label =
        ACCOUNT_BULK_ACTIONS.find((a) => a.key === action)?.label || action;

      toast({
        variant: result.failed > 0 ? "destructive" : "success",
        title: `${label}: ${result.succeeded}/${result.total} succeeded`,
        description:
          result.failed > 0
            ? `${result.failed} failed. See console for details.`
            : `${label} completed on ${result.succeeded} account${result.succeeded !== 1 ? "s" : ""}.`,
      });

      selection.clear();
      loadAccountsWithFilters();
      loadStats();
    } catch (error) {
      console.error("Error running bulk account action:", error);
      toast({
        variant: "destructive",
        title: "Bulk Action Failed",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  // Calculate summary statistics
  const stats = {
    total: allAccounts.length, // totalItems might correspond to filtered total, but for "Total Accounts" card we likely want absolute total or filtered total. Let's use allAccounts.length effectively (assuming no filters on loadStats)
    active: allAccounts.filter((a) => a.active).length,
    inactive: allAccounts.filter((a) => !a.active).length,
    connected: allAccounts.filter((a) => a.connectionStatus === 'connected').length,
    totalSavings: allAccounts.reduce(
      (sum, a) => sum + (a.monthlySavings || 0),
      0
    ),
    totalResources: allAccounts.reduce(
      (sum, a) => sum + (a.resourceCount || 0),
      0
    ),
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between sticky top-0 z-10 bg-background p-4 border-b">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AWS Accounts</h1>
          <p className="text-muted-foreground">
            Manage and monitor your AWS accounts and their configurations
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            onClick={refreshAccounts}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
            <Button onClick={() => router.push("/app/accounts/create")}>
              <Plus className="mr-2 h-4 w-4" />
              Integrate Account
            </Button>
          </div>
        </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error}
            <Button
              variant="link"
              onClick={refreshAccounts}
              className="ml-2 p-0 h-auto"
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading State */}
      {loading && !error && accounts.length === 0 && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin" />
              <p className="mt-2 text-sm text-muted-foreground">
                Loading accounts...
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Accounts
            </CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
            <p className="text-xs text-muted-foreground">
              {stats.active} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connected</CardTitle>
            <Shield className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.connected}</div>
             <p className="text-xs text-muted-foreground">
              active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Resources</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.totalResources.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">managed resources</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Monthly Savings
            </CardTitle>
            <span className="text-success dark:text-success">$</span>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${stats.totalSavings.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              estimated savings
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Selected</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {selection.count}
            </div>
            <p className="text-xs text-muted-foreground">
              {selection.count > 0 ? "use the bulk action bar below" : "none selected"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>
            Search and filter accounts to find what you need
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Search accounts by name, ID, description..."
                value={localSearchTerm}
                onChange={(e) => setLocalSearchTerm(e.target.value)}
                className="w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApplyFilter();
                }}
              />
            </div>
            <Select value={localStatusFilter} onValueChange={setLocalStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                {statusFilters.map((filter) => (
                  <SelectItem key={filter.value} value={filter.value}>
                    {filter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={localConnectionFilter}
              onValueChange={setLocalConnectionFilter}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by connection" />
              </SelectTrigger>
              <SelectContent>
                {connectionFilters.map((filter) => (
                  <SelectItem key={filter.value} value={filter.value}>
                    {filter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="default"
              onClick={handleApplyFilter}
            >
              Apply Filters
            </Button>
            <Button
              variant="outline"
              onClick={handleClearFilter}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk action bar — appears when rows are selected */}
      <BulkActionBar
        count={selection.count}
        actions={ACCOUNT_BULK_ACTIONS}
        onAction={handleBulkAction}
        onClear={selection.clear}
        isLoading={bulkLoading}
        itemNoun="account"
      />

      {/* View Toggle and Content */}
      <Tabs
        value={viewMode}
        onValueChange={(value) => setViewMode(value as "table" | "grid")}
      >
        <TabsList>
          <TabsTrigger value="table">Table View</TabsTrigger>
          <TabsTrigger value="grid">Grid View</TabsTrigger>
        </TabsList>

        <TabsContent value="table" className="space-y-4">
          <AccountsTable
            accounts={accounts}
            onAccountUpdated={handleAccountUpdated}
            isSelected={selection.isSelected}
            onToggleSelect={selection.toggle}
            allSelected={selection.allSelected}
            someSelected={selection.someSelected}
            onToggleSelectAll={selection.selectAll}
          />
        </TabsContent>

        <TabsContent value="grid" className="space-y-4">
          <AccountsGrid
            accounts={accounts}
            onAccountUpdated={handleAccountUpdated}
            isSelected={selection.isSelected}
            onToggleSelect={selection.toggle}
          />
        </TabsContent>
      </Tabs>

      {/* Pagination */}
      {!loading && (
        <PaginationBar
          currentPage={currentPage}
          totalItems={totalItems}
          pageSize={limit}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setLimit(size); setCurrentPage(1); }}
          pageSizeOptions={[10, 25, 50, 100]}
          itemLabel="accounts"
        />
      )}

      {/* Dialogs */}
      <ImportAccountsDialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          // If dialog is closed after successful import, refresh accounts
          if (!open) refreshAccounts();
        }}
      />
    </div>
  );
}
