"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Loader2 } from "lucide-react";
import { EditAccountForm } from "./edit-account-form";
import { UIAccount } from "@/lib/types";
import { ClientAccountService } from "@/lib/client-account-service";

interface EditAccountViewProps {
  params: Promise<{
    accountId: string;
  }>;
  hubAccountId: string;
}

export default function EditAccountView({ params, hubAccountId }: EditAccountViewProps) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [account, setAccount] = useState<UIAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const accountId = resolvedParams.accountId;

  useEffect(() => {
    const fetchAccount = async () => {
      try {
        setLoading(true);
        setError(null);
        const accountData = await ClientAccountService.getAccount(accountId);
        if (!accountData) {
          setError("Account not found");
          return;
        }
        setAccount(accountData);
      } catch (err) {
        console.error("Failed to fetch account:", err);
        setError("Failed to load account data");
      } finally {
        setLoading(false);
      }
    };

    fetchAccount();
  }, [accountId]);

  if (loading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p className="text-muted-foreground">Loading account...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-between mb-6">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-2">
                {error || "Account not found"}
              </h3>
              <p className="text-muted-foreground mb-4">
                The account "{accountId}" could not be loaded.
              </p>
              <Button onClick={() => router.push("/app/accounts")}>
                Return to Accounts
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full py-6 overflow-hidden">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Edit Account</h1>
            <p className="text-muted-foreground">
              Modify the account "{account.name}"
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Configuration</CardTitle>
          <CardDescription>
            Update the account settings and AWS configuration
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EditAccountForm account={account} hubAccountId={hubAccountId} />
        </CardContent>
      </Card>
    </div>
  );
}
