"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
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
import { DeleteAccountDialog } from "@/components/accounts/delete-account-dialog";
import { useToast } from "@/hooks/use-toast";

interface AccountsGridProps {
  accounts: UIAccount[];
  onAccountUpdated?: () => void;
}

export function AccountsGrid({
  accounts,
  onAccountUpdated,
}: AccountsGridProps) {
  const router = useRouter();
  const [deletingAccount, setDeletingAccount] = useState<UIAccount | null>(
    null
  );
  const [loadingActions, setLoadingActions] = useState<string | null>(null);
  const { toast } = useToast();

  const validateConnection = async (accountId: string) => {
    try {
      setLoadingActions(accountId);

      // Implement actual validation by checking AWS credentials and permissions
      const result = await ClientAccountService.validateAccount({
          accountId: accountId,
          region: 'us-east-1'
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
        description: `Account ${account.active ? "deactivated" : "activated"
          } successfully.`,
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
    if (
      !confirm(
        `Are you sure you want to delete account "${account.name}"? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      setDeletingAccount(account);
      await ClientAccountService.deleteAccount(account.id);
      onAccountUpdated?.();
      toast({
        variant: "success",
        title: "Account Deleted",
        description: `Account "${account.name}" deleted successfully.`,
      });
    } catch (error: any) {
      console.error("Error deleting account:", error);
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "Failed to delete account.",
      });
    } finally {
      setDeletingAccount(null);
    }
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
            className="bg-success/10 text-green-800"
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
            className="bg-warning/10 text-yellow-800"
          >
            Warning
          </Badge>
        );
      case "validating":
        return <Badge variant="outline" className="border-blue-500 text-info">Validating...</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {accounts.map((account) => {
          const connectionStatus = getConnectionStatus(account);
          return (
            <Card
              key={account.id}
              className="relative hover:shadow-md transition-shadow"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <CardTitle className="text-lg">
                        {account.name || "Unnamed Account"}
                        </CardTitle>
                        <Badge variant={account.active ? "default" : "secondary"} className="text-xs h-5">
                            {account.active ? "Active" : "Inactive"}
                        </Badge>
                    </div>
                    
                    <CardDescription className="font-mono text-sm">
                      {account.accountId}
                    </CardDescription>
                  </div>
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
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Role ARN */}
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">
                    Role ARN
                  </div>
                  <div className="text-sm font-mono truncate">
                    {account.roleArn || "N/A"}
                  </div>
                </div>

                {/* Regions */}
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">
                    Regions
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {account.regions?.map((region: string) => (
                      <Badge key={region} variant="outline" className="text-xs">
                        {region}
                      </Badge>
                    )) || (
                        <span className="text-sm text-muted-foreground">N/A</span>
                      )}
                  </div>
                </div>
                
                <Separator />

                {/* Status Columns */}
                <div className="grid grid-cols-2 gap-4">
                    {/* Account Status */}
                    <div className="space-y-2">
                        <div className="text-sm font-medium text-muted-foreground">
                            Account Status
                        </div>
                        <Badge variant={account.active ? "default" : "secondary"} className={account.active ? "bg-success/10 text-green-800" : ""}>
                            {account.active ? "Active" : "Inactive"}
                        </Badge>
                    </div>

                    {/* Connection Status */}
                    <div className="space-y-2">
                        <div className="text-sm font-medium text-muted-foreground">
                            Connection
                        </div>
                        <div className="flex items-center space-x-2">
                            {getStatusIcon(connectionStatus)}
                            {getStatusBadge(connectionStatus)}
                        </div>
                        {account.connectionError && account.connectionError !== 'None' && (
                           <p className="text-xs text-destructive truncate max-w-[120px]" title={account.connectionError}>
                              {account.connectionError}
                           </p>
                        )}
                    </div>
                </div>
              </CardContent>

              <CardFooter className="flex items-center justify-between pt-4 border-t bg-muted/20">
                <div className="flex items-center space-x-2 w-full">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    onClick={() => validateConnection(account.id)}
                    disabled={loadingActions === account.id}
                  >
                    {loadingActions === account.id ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="mr-2 h-3 w-3" />
                    )}
                    Validate
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    onClick={() => toggleAccountStatus(account)}
                    disabled={loadingActions === account.id}
                  >
                    {loadingActions === account.id ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : account.active ? (
                      <PowerOff className="mr-2 h-3 w-3" />
                    ) : (
                      <Power className="mr-2 h-3 w-3" />
                    )}
                    {account.active ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {accounts.length === 0 && (
        <div className="text-center py-12">
          <Server className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-2 text-sm font-semibold">No accounts found</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Try adjusting your search terms or add a new AWS account.
          </p>
        </div>
      )}

      <DeleteAccountDialog
        account={deletingAccount}
        open={!!deletingAccount}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingAccount(null);
            onAccountUpdated?.();
          }
        }}
      />
    </div>
  );
}
