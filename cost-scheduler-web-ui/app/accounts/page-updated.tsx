"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Server, Plus, Download, RefreshCw, Globe, Shield, Loader2, AlertCircle } from "lucide-react"
import { AccountsTable } from "@/components/accounts/accounts-table"
import { AccountsGrid } from "@/components/accounts/accounts-grid"
import { CreateAccountDialog } from "@/components/accounts/create-account-dialog"
import { BulkAccountActionsDialog } from "@/components/accounts/bulk-account-actions-dialog"
import { ImportAccountsDialog } from "@/components/accounts/import-accounts-dialog"
import { ClientAccountService } from "@/lib/client-account-service"
import { UIAccount } from "@/lib/types"

const statusFilters = [
  { value: "all", label: "All Accounts" },
  { value: "active", label: "Active Only" },
  { value: "inactive", label: "Inactive Only" },
]

const connectionFilters = [
  { value: "all", label: "All Connections" },
  { value: "connected", label: "Connected" },
  { value: "error", label: "Connection Error" },
  { value: "warning", label: "Warning" },
  { value: "validating", label: "Validating" },
]

export default function AccountsPage() {
  // Data state
  const [accounts, setAccounts] = useState<UIAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [connectionFilter, setConnectionFilter] = useState("all")
  const [viewMode, setViewMode] = useState<"table" | "grid">("table")
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)

  // Load accounts from DynamoDB
  const loadAccounts = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await ClientAccountService.getAccounts()
      setAccounts(data)
    } catch (err) {
      console.error('Error loading accounts:', err)
      setError(err instanceof Error ? err.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }

  // Load accounts on component mount
  useEffect(() => {
    loadAccounts()
  }, [])

  // Filter accounts based on search and filters
  const filteredAccounts = accounts.filter((account) => {
    const matchesSearch =
      account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      account.accountId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (account.description && account.description.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (account.createdBy && account.createdBy.toLowerCase().includes(searchTerm.toLowerCase()))

    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && account.active) ||
      (statusFilter === "inactive" && !account.active)

    const matchesConnection = connectionFilter === "all" ||
      account.connectionStatus === connectionFilter

    return matchesSearch && matchesStatus && matchesConnection
  })

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedAccounts(filteredAccounts.map((a) => a.id))
    } else {
      setSelectedAccounts([])
    }
  }

  const handleSelectAccount = (accountId: string, checked: boolean) => {
    if (checked) {
      setSelectedAccounts([...selectedAccounts, accountId])
    } else {
      setSelectedAccounts(selectedAccounts.filter((id) => id !== accountId))
    }
  }

  const exportAccounts = () => {
    // TODO: Implement export functionality
    console.log("Exporting accounts...")
  }

  const refreshAccounts = () => {
    loadAccounts()
  }

  // Calculate summary statistics
  const stats = {
    total: filteredAccounts.length,
    active: filteredAccounts.filter((a) => a.active).length,
    inactive: filteredAccounts.filter((a) => !a.active).length,
    connected: filteredAccounts.filter((a) => a.connectionStatus === "connected").length,
    totalSavings: filteredAccounts.reduce((sum, a) => sum + (a.monthlySavings || 0), 0),
    totalResources: filteredAccounts.reduce((sum, a) => sum + (a.resourceCount || 0), 0),
  }

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">Account Management</h2>
          <p className="text-muted-foreground">
            Manage AWS accounts for cost optimization across your infrastructure
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" onClick={refreshAccounts} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setImportDialogOpen(true)} disabled={loading}>
            <Plus className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={exportAccounts} disabled={loading}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)} disabled={loading}>
            <Plus className="mr-2 h-4 w-4" />
            Add Account
          </Button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error}
            <Button variant="link" onClick={loadAccounts} className="ml-2 p-0 h-auto">
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
              <p className="mt-2 text-sm text-muted-foreground">Loading accounts...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats - only show when not loading */}
      {!loading && (
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Accounts</CardTitle>
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
                {stats.total > 0 ? ((stats.connected / stats.total) * 100).toFixed(1) : 0}% success rate
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resources</CardTitle>
              <Globe className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalResources.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">managed resources</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monthly Savings</CardTitle>
              <span className="text-success dark:text-success">$</span>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${stats.totalSavings.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">across all accounts</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Selected</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{selectedAccounts.length}</div>
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
            <CardDescription>Search and filter accounts to find what you need</CardDescription>
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
              <Select value={connectionFilter} onValueChange={setConnectionFilter}>
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
            </div>
          </CardContent>
        </Card>
      )}

      {/* View Toggle and Content - only show when not loading */}
      {!loading && (
        <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as "table" | "grid")}>
          <TabsList>
            <TabsTrigger value="table">Table View</TabsTrigger>
            <TabsTrigger value="grid">Grid View</TabsTrigger>
          </TabsList>

          <TabsContent value="table" className="space-y-4">
            <AccountsTable
              accounts={filteredAccounts}
              selectedAccounts={selectedAccounts}
              onSelectAll={handleSelectAll}
              onSelectAccount={handleSelectAccount}
            />
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            <AccountsGrid
              accounts={filteredAccounts}
              selectedAccounts={selectedAccounts}
              onSelectAccount={handleSelectAccount}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Dialogs */}
      <CreateAccountDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <BulkAccountActionsDialog
        open={bulkActionsOpen}
        onOpenChange={setBulkActionsOpen}
        selectedAccounts={selectedAccounts}
        onClearSelection={() => setSelectedAccounts([])}
      />
      <ImportAccountsDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
    </div>
  )
}
