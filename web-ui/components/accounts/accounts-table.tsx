"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Edit,
  Trash2,
  RefreshCw,
  Server,
  Eye,
  Shield,
  Loader2,
  Power,
  PowerOff,
} from "lucide-react";
import { UIAccount } from "@/lib/types";
import { ClientAccountService } from "@/lib/client-account-service";
import { formatDate } from "@/lib/date-utils";
import { DeleteAccountDialog } from "@/components/accounts/delete-account-dialog";
import { useToast } from "@/hooks/use-toast";

interface AccountsTableProps {
  accounts: UIAccount[];
  onAccountUpdated?: () => void;
}

export function AccountsTable({
  accounts,
  onAccountUpdated,
}: AccountsTableProps) {
  const router = useRouter();
  const [deletingAccount, setDeletingAccount] = useState<UIAccount | null>(null);
  const [loadingActions, setLoadingActions] = useState<string | null>(null);
  const { toast } = useToast();

  const validateConnection = async (accountId: string) => {
    try {
      setLoadingActions(accountId);

      // Implement actual validation by checking AWS credentials and permissions
      const result = await ClientAccountService.validateAccount({
          accountId: accountId,
          region: 'us-east-1' // Default, service will pick up correct one
      });

      if (result.isValid) {
        toast({
          variant: "success",
          title: "Connection Validated",
          description: "Account connection is working properly.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Validation Failed",
          description: result.error || "Unable to validate account connection.",
        });
      }

      onAccountUpdated?.();
    } catch (error: any) {
      console.error("Error validating connection:", error);
      toast({
        variant: "destructive",
        title: "Validation Failed",
        description: error.message || "Failed to validate account connection.",
      });
    } finally {
      setLoadingActions(null);
    }
  };

  const toggleAccountStatus = async (account: UIAccount) => {
    try {
      setLoadingActions(account.id);
      await ClientAccountService.updateAccount(account.id, {
        active: !account.active,
      });
      // Ensure the callback is called to refresh the parent data
      if (onAccountUpdated) {
        onAccountUpdated();
      }
      toast({
        variant: "success",
        title: "Status Updated",
        description: `Account ${account.active ? "deactivated" : "activated"} successfully.`,
      });
    } catch (error: any) {
      console.error("Error toggling account status:", error);
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "Failed to toggle account status.",
      });
    } finally {
      setLoadingActions(null);
    }
  };

  const deleteAccount = async (account: UIAccount) => {
    // Just set the account to be deleted, the dialog will handle the rest
    setDeletingAccount(account);
  };

  const getConnectionStatus = (account: UIAccount) => {
    return account.connectionStatus || "unknown";
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "connected":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
       case "validating":
        return <RefreshCw className="h-4 w-4 text-info animate-spin" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "connected":
        return (
          <Badge
            variant="default"
            className="bg-success/10 text-success"
          >
            Connected
          </Badge>
        );
      case "error":
        return <Badge variant="destructive">Connection Error</Badge>;
      case "warning":
        return (
          <Badge
            variant="secondary"
            className="bg-warning/10 text-warning"
          >
            Warning
          </Badge>
        );
      case "validating":
        return <Badge variant="outline" className="border-info text-info">Validating...</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Role ARN</TableHead>
              <TableHead>Regions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[70px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts && accounts.length > 0 ? (
              accounts.map((account, index) => (
                <TableRow
                  key={`${account.accountId}-${account.name}-${index}`}
                  className="hover:bg-muted/50"
                >
                  <TableCell>
                    <div className="space-y-1">
                      <button
                        onClick={() => router.push(`/accounts/${encodeURIComponent(account.accountId)}`)}
                        className="font-medium text-left hover:text-primary hover:underline transition-colors cursor-pointer"
                      >
                        {account.name || "Unnamed Account"}
                      </button>
                      <div className="text-sm text-muted-foreground">
                        {account.accountId}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[200px] truncate text-sm font-mono">
                      {account.roleArn || "N/A"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {account.regions && account.regions.length > 0 ? (
                        // Remove duplicates and map with unique keys
                        [...new Set(account.regions)].map((region: string, index: number) => (
                          <Badge
                            key={`${region}-${index}`}
                            variant="outline"
                            className="text-xs"
                          >
                            {region}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          N/A
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-2">
                       {/* Connection Status */}
                       <div className="flex items-center space-x-2">
                          {getStatusIcon(getConnectionStatus(account))}
                          {getStatusBadge(getConnectionStatus(account))}
                       </div>
                       
                      {/* Active Status */}
                      <Badge
                        variant={account.active ? "default" : "secondary"}
                        className={
                          account.active
                            ? "bg-success/10 text-success"
                            : ""
                        }
                      >
                        {account.active ? "Active" : "Inactive"}
                      </Badge>
                      
                       {/* Quick Actions */}
                      <div className="flex items-center space-x-2 pt-1">
                        <button
                          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 px-2"
                          onClick={() => validateConnection(account.id)}
                          disabled={loadingActions === account.id}
                          title="Validate Connection"
                        >
                          {loadingActions === account.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 px-2"
                          onClick={() => toggleAccountStatus(account)}
                          disabled={loadingActions === account.id}
                          title={account.active ? "Deactivate" : "Activate"}
                        >
                          {loadingActions === account.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : account.active ? (
                            <PowerOff className="h-3 w-3" />
                          ) : (
                            <Power className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-muted-foreground">
                      {account.createdAt
                        ? formatDate(account.createdAt)
                        : "N/A"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          disabled={loadingActions === account.id}
                        >
                          {loadingActions === account.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreHorizontal className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => router.push(`/accounts/${account.id}`)}
                        >
                          <Eye className="mr-2 h-4 w-4" />
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            router.push(`/accounts/${account.id}/edit`)
                          }
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => validateConnection(account.id)}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Validate Connection
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeletingAccount(account)}
                          className="text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12">
                  <Server className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-2 text-sm font-semibold">
                    No accounts found
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Try adjusting your search terms or add a new AWS account.
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <DeleteAccountDialog
        account={deletingAccount}
        open={!!deletingAccount}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingAccount(null);
          }
        }}
        onDeleted={() => {
          // Call the parent's update function to refresh the accounts list
          onAccountUpdated?.();
        }}
      />
    </Card>
  );
}
