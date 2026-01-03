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
  Download,
  RefreshCw,
  Globe,
  Shield,
  Loader2,
  AlertCircle,
  Upload,
} from "lucide-react";
import { AccountsTable } from "@/components/accounts/accounts-table";
import { AccountsGrid } from "@/components/accounts/accounts-grid";
import { BulkAccountActionsDialog } from "@/components/accounts/bulk-account-actions-dialog";
import { ImportAccountsDialog } from "@/components/accounts/import-accounts-dialog";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { useIsFirstRender } from "@/hooks/use-first-render";

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
  statusFilters,
  connectionFilters,
}: AccountsClientProps) {
  const router = useRouter();

  // Data state
  const [accounts, setAccounts] = useState<UIAccount[]>(initialAccounts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state - initialize with server provided values or defaults
  const [searchTerm, setSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [statusFilter, setStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [connectionFilter, setConnectionFilter] = useState(initialFilters?.connectionFilter || "all");
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  
  const { toast } = useToast();



  // Load accounts from API
  const loadAccounts = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await ClientAccountService.getAccounts();
      if (Array.isArray(result)) {
           setAccounts(result);
      } else {
           setAccounts(result.accounts);
      }
    } catch (err) {
      console.error("Error loading accounts:", err);
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  };

  // Pagination state
  const [pageTokens, setPageTokens] = useState<(string | undefined)[]>([undefined]);
  const [currentPage, setCurrentPage] = useState(0);
  const [lastNextToken, setLastNextToken] = useState<string | undefined>(undefined);
  const ITEMS_PER_PAGE = 10;

  // Load accounts with current filters
  const loadAccountsWithFilters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const currentToken = pageTokens[currentPage];

      const filters = {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        connectionFilter: connectionFilter !== 'all' ? connectionFilter : undefined,
        searchTerm: searchTerm || undefined,
        limit: ITEMS_PER_PAGE,
        nextToken: currentToken
      };
      
      const result = await ClientAccountService.getAccounts(filters);
      
      // Handle the new return type object
      if (Array.isArray(result)) {
          // Fallback if service returns array (shouldn't happen with updated service)
          setAccounts(result);
          setLastNextToken(undefined);
      } else {
          setAccounts(result.accounts);
          setLastNextToken(result.nextToken);
      }
      
    } catch (err) {
      console.error("Error loading accounts:", err);
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, connectionFilter, searchTerm, currentPage, pageTokens]); // Depend on currentPage and pageTokens

  const handleNextPage = () => {
      if (lastNextToken) {
          const newTokens = [...pageTokens];
          if (newTokens.length <= currentPage + 1) {
              newTokens.push(lastNextToken);
          }
          setPageTokens(newTokens);
          setCurrentPage(currentPage + 1);
      }
  };

  const handlePreviousPage = () => {
      if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
      }
  };

  // Handle account updates - this will be called by child components
  const handleAccountUpdated = (message?: string) => {
    loadAccountsWithFilters();
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

  // Note: Auto-filtering on value change is removed. 
  // Users must click "Apply Filters" or "Clear Filters" to trigger data refresh.


  // Use accounts directly since filtering is done server-side
  const filteredAccounts = accounts;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedAccounts(filteredAccounts.map((a) => a.id));
    } else {
      setSelectedAccounts([]);
    }
  };

  const handleSelectAccount = (accountId: string, checked: boolean) => {
    if (checked) {
      setSelectedAccounts([...selectedAccounts, accountId]);
    } else {
      setSelectedAccounts(selectedAccounts.filter((id) => id !== accountId));
    }
  };

  const exportAccounts = () => {
    // TODO: Implement export functionality
    console.log("Exporting accounts...");
  };

  const refreshAccounts = () => {
    loadAccounts();
  };

  const handleCreateAccount = () => {
    router.push("/accounts/create");
  };

  // Calculate summary statistics - fix connection status calculation
  const stats = {
    total: filteredAccounts.length,
    active: filteredAccounts.filter((a) => a.active).length,
    inactive: filteredAccounts.filter((a) => !a.active).length,
    connected: filteredAccounts.filter((a) => a.active).length, // Use active status as connection indicator
    totalSavings: filteredAccounts.reduce(
      (sum, a) => sum + (a.monthlySavings || 0),
      0
    ),
    totalResources: filteredAccounts.reduce(
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
          {/* <Button onClick={() => setImportDialogOpen(true)} variant="outline">
              <Upload className="mr-2 h-4 w-4" />
              Import Accounts
            </Button> */}
            <Button onClick={() => router.push("/accounts/create")}>
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
              onClick={loadAccounts}
              className="ml-2 p-0 h-auto"
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading State */}
      {loading && !error && (
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

      {/* Summary Stats - only show when not loading */}
      {!loading && (
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
                {stats.active} active, {stats.inactive} inactive
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
                {stats.total > 0
                  ? ((stats.connected / stats.total) * 100).toFixed(1)
                  : 0}
                % success rate
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
                across all accounts
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
                {selectedAccounts.length}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedAccounts.length > 0 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 h-auto text-xs"
                    onClick={() => setBulkActionsOpen(true)}
                  >
                    Bulk actions
                  </Button>
                )}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters and Search - only show when not loading */}
      {!loading && (
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
                  placeholder="Search accounts by name, ID, description, or creator..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
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
                value={connectionFilter}
                onValueChange={setConnectionFilter}
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
                onClick={() => {
                  setCurrentPage(0);
                  setPageTokens([undefined]);
                  loadAccountsWithFilters();
                }}
              >
                Apply Filters
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSearchTerm("");
                  setStatusFilter("all");
                  setConnectionFilter("all");
                  setCurrentPage(0);
                  setPageTokens([undefined]);
                  loadAccounts();
                }}
              >
                Clear Filters
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* View Toggle and Content - only show when not loading */}
      {!loading && (
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
              accounts={filteredAccounts}
              onAccountUpdated={handleAccountUpdated}
            />
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            <AccountsGrid
              accounts={filteredAccounts}
              onAccountUpdated={handleAccountUpdated}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Pagination Controls */}
      {!loading && (currentPage > 0 || lastNextToken) && (
        <div className="flex items-center justify-end space-x-2 py-4">
            <Button
                variant="outline"
                size="sm"
                onClick={handlePreviousPage}
                disabled={currentPage === 0}
            >
                Previous
            </Button>
            <div className="text-sm text-muted-foreground">
                Page {currentPage + 1}
            </div>
            <Button
                variant="outline"
                size="sm"
                onClick={handleNextPage}
                disabled={!lastNextToken}
            >
                Next
            </Button>
        </div>
      )}

      {/* Dialogs */}
      <BulkAccountActionsDialog
        open={bulkActionsOpen}
        onOpenChange={(open) => {
          setBulkActionsOpen(open);
          // If dialog is closed after successful action, refresh accounts
          if (!open && selectedAccounts.length > 0) {
            loadAccounts();
            setSelectedAccounts([]);
          }
        }}
        selectedAccounts={selectedAccounts}
        onClearSelection={() => setSelectedAccounts([])}
      />
      <ImportAccountsDialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          // If dialog is closed after successful import, refresh accounts
          if (!open) loadAccounts();
        }}
      />
    </div>
  );
}
