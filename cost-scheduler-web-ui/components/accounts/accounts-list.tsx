"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Server, MoreHorizontal, AlertCircle } from "lucide-react";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";

export function AccountsList({
  accounts,
  loading,
  error,
}: {
  accounts: UIAccount[];
  loading: boolean;
  error: any
}) {
  // const [accounts, setAccounts] = useState<UIAccount[]>([]);
  // const [loading, setLoading] = useState(true);
  // const [error, setError] = useState<string | null>(null);

  // useEffect(() => {
  //   const fetchAccounts = async () => {
  //     try {
  //       setLoading(true);
  //       setError(null);
  //       const accountsData = await ClientAccountService.getAccounts();
  //       setAccounts(accountsData);
  //     } catch (err) {
  //       console.error("Failed to fetch accounts:", err);
  //       setError("Failed to load accounts");
  //       // Fallback to empty array instead of mock data
  //       setAccounts([]);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };

  //   fetchAccounts();
  // }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AWS Accounts</CardTitle>
          <CardDescription>Manage your AWS accounts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AWS Accounts</CardTitle>
          <CardDescription>Manage your AWS accounts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center h-32">
            <AlertCircle className="h-8 w-8 text-destructive mb-2" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AWS Accounts</CardTitle>
        <CardDescription>Manage your AWS accounts</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {accounts.length > 0 ? (
            accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-4 border rounded-lg"
              >
                <div>
                  <div className="flex items-center space-x-2">
                    <Server className="h-4 w-4" />
                    <p className="font-medium">{account.name}</p>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Account ID: {account.accountId} • Regions:{" "}
                    {account.regions.join(", ")}
                  </div>
                  {account.description && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {account.description}
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <Badge variant={account.active ? "default" : "secondary"}>
                    {account.active ? "Active" : "Inactive"}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      account.connectionStatus === "connected"
                        ? "text-success border-green-300"
                        : account.connectionStatus === "error"
                          ? "text-destructive border-red-300"
                          : "text-warning border-yellow-300"
                    }
                  >
                    {account.connectionStatus || "Unknown"}
                  </Badge>
                  <Button variant="outline" size="sm">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-8">
              <Server className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-2 text-sm font-semibold">
                No AWS accounts found
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Add your first AWS account to get started with cost
                optimization.
              </p>
            </div>
          )}
        </div>
        <div className="mt-4 text-center">
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/accounts")}
          >
            View All Accounts
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
