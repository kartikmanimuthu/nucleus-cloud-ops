"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Edit,
  RefreshCw,
  Trash2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Server,
  Shield,
  Calendar,
  DollarSign,
  Globe,
  Clock,
  Tag,
  Eye,
  Loader2,
} from "lucide-react";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { DeleteAccountDialog } from "@/components/accounts/delete-account-dialog";

interface AccountDetailPageProps {
  params: Promise<{
    accountId: string;
  }>;
}

// Mock data for related information
const mockResources = [
  {
    id: "res-001",
    type: "EC2",
    name: "web-server-01",
    region: "us-east-1",
    status: "running",
    lastAction: "2024-01-15T08:30:00Z",
    tags: [
      { key: "Name", value: "Web Server 01" },
      { key: "Environment", value: "Production" },
    ],
  },
  {
    id: "res-002",
    type: "RDS",
    name: "prod-db-cluster",
    region: "us-east-1",
    status: "stopped",
    lastAction: "2024-01-15T22:00:00Z",
    tags: [
      { key: "Name", value: "Production DB" },
      { key: "Environment", value: "Production" },
    ],
  },
  {
    id: "res-003",
    type: "EC2",
    name: "app-server-01",
    region: "us-west-2",
    status: "running",
    lastAction: "2024-01-14T09:15:00Z",
    tags: [
      { key: "Name", value: "App Server 01" },
      { key: "Environment", value: "Production" },
    ],
  },
];

const mockSchedules = [
  {
    id: "sch-001",
    name: "Production DB Shutdown",
    description: "Stop production databases outside business hours",
    active: true,
    nextExecution: "2024-01-16T22:00:00Z",
    resourceTypes: ["RDS", "DocumentDB"],
  },
  {
    id: "sch-002",
    name: "Development Environment",
    description: "Stop development resources during weekends",
    active: true,
    nextExecution: "2024-01-20T18:00:00Z",
    resourceTypes: ["EC2", "RDS"],
  },
];

const mockActivity = [
  {
    id: "act-001",
    timestamp: "2024-01-15T22:00:00Z",
    action: "Schedule Executed",
    details: "Production DB Shutdown executed successfully",
    status: "success",
    resources: 3,
  },
  {
    id: "act-002",
    timestamp: "2024-01-15T10:30:00Z",
    action: "Connection Validated",
    details: "Account connection validated successfully",
    status: "success",
    resources: 0,
  },
  {
    id: "act-003",
    timestamp: "2024-01-14T22:00:00Z",
    action: "Schedule Executed",
    details: "Production DB Shutdown executed successfully",
    status: "success",
    resources: 3,
  },
];

export default function AccountDetailPage({ params }: AccountDetailPageProps) {
  const router = useRouter();
  const { accountId } = use(params);
  const [account, setAccount] = useState<UIAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [validatingConnection, setValidatingConnection] = useState(false);

  const loadAccount = async () => {
    try {
      setLoading(true);
      setError(null);
      const accountData = await ClientAccountService.getAccount(
        decodeURIComponent(accountId)
      );
      if (!accountData) {
        setError("Account not found");
        return;
      }
      setAccount(accountData);
    } catch (err: any) {
      setError(err.message || "Failed to load account");
      console.error("Error loading account:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccount();
  }, [accountId]);

  const validateConnection = async () => {
    if (!account) return;

    try {
      setValidatingConnection(true);
      // Client-side validation call
      await ClientAccountService.validateAccount({
        accountId: account.accountId,
        region: account.regions[0] || 'us-east-1'
        // roleArn and externalId intentionally omitted to trigger stored-account validation (persisted to DB)
      });
      await loadAccount(); // Reload to get updated status
    } catch (error) {
      console.error("Error validating connection:", error);
    } finally {
      setValidatingConnection(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "connected":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "inactive":
        return <XCircle className="h-4 w-4 text-gray-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case "success":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "connected":
        return (
          <Badge
            variant="default"
            className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
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
            className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100"
          >
            Warning
          </Badge>
        );
      case "success":
        return (
          <Badge
            variant="default"
            className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
          >
            Success
          </Badge>
        );
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="container mx-auto py-8">
        <Card>
          <CardContent className="p-6">
            <div className="text-center">
              <AlertTriangle className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-2 text-lg font-semibold">Account Not Found</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {error || "The requested account could not be found."}
              </p>
              <Button className="mt-4" onClick={() => router.push("/accounts")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Accounts
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push("/accounts")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Accounts
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center space-x-2">
              <Server className="h-6 w-6" />
              <span>{account.name}</span>
            </h1>
            <p className="text-muted-foreground">
              AWS Account ID: {account.accountId}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            onClick={validateConnection}
            disabled={validatingConnection}
          >
            {validatingConnection ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Validate
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              router.push(
                `/accounts/${encodeURIComponent(account.accountId)}/edit`
              )
            }
          >
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => setDeletingAccount(true)}
            className="text-red-600 hover:text-red-700"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {/* Stats Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Status</CardTitle>
                <Shield className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex items-center space-x-2">
                  {getStatusIcon(account.connectionStatus || "unknown")}
                  {getStatusBadge(account.connectionStatus || "unknown")}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Last validated:{" "}
                  {account.lastValidated
                    ? new Date(account.lastValidated).toLocaleString()
                    : "Never"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Resources</CardTitle>
                <Server className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {account.resourceCount}
                </div>
                <p className="text-xs text-muted-foreground">
                  managed resources
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Schedules</CardTitle>
                <Calendar className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {account.schedulesCount}
                </div>
                <p className="text-xs text-muted-foreground">
                  active schedules
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Monthly Savings
                </CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  ${account.monthlySavings}
                </div>
                <p className="text-xs text-muted-foreground">estimated</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Account Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Basic Information</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Name:</span>
                      <span>{account.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Account ID:</span>
                      <span className="font-mono">{account.accountId}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status:</span>
                      <Badge variant={account.active ? "default" : "secondary"}>
                        {account.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Description:
                      </span>
                      <span className="text-right max-w-[200px]">
                        {account.description}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">IAM Role</h4>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Role ARN:</span>
                      <div className="mt-1 font-mono text-xs break-all">
                        {account.roleArn}
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Connection Status:
                      </span>
                      <div className="flex items-center space-x-2">
                        {getStatusIcon(account.connectionStatus || "unknown")}
                        <span>{account.connectionStatus || "unknown"}</span>
                      </div>
                    </div>
                    {account.connectionError && account.connectionError !== 'None' && (
                        <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
                             <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                                Error: {account.connectionError}
                             </p>
                        </div>
                    )}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-medium">AWS Regions</h4>
                <div className="flex flex-wrap gap-2">
                  {account.regions.map((region: string) => (
                    <Badge key={region} variant="outline">
                      <Globe className="h-3 w-3 mr-1" />
                      {region}
                    </Badge>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Tags</h4>
                <div className="flex flex-wrap gap-2">
                  {account.tags && account.tags.length > 0 ? (
                    account.tags.map((tag: any, index: number) => (
                      <Badge key={index} variant="outline">
                        <Tag className="h-3 w-3 mr-1" />
                        {tag.key}={tag.value}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No tags configured
                    </span>
                  )}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Metadata</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created:</span>
                      <span>
                        {account.createdAt
                          ? new Date(account.createdAt).toLocaleDateString()
                          : "N/A"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created By:</span>
                      <span>{account.createdBy}</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Last Updated:
                      </span>
                      <span>
                        {account.updatedAt
                          ? new Date(account.updatedAt).toLocaleDateString()
                          : "N/A"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Updated By:</span>
                      <span>{account.updatedBy}</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="resources" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Managed Resources</CardTitle>
              <CardDescription>
                Resources managed by cost optimization schedules
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {mockResources.map((resource) => (
                  <div
                    key={resource.id}
                    className="flex items-start space-x-4 p-4 border rounded-lg"
                  >
                    <div className="flex-shrink-0 mt-1">
                      <Badge
                        variant="outline"
                        className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100"
                      >
                        {resource.type}
                      </Badge>
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{resource.name}</div>
                        <Badge
                          variant={
                            resource.status === "running"
                              ? "default"
                              : "secondary"
                          }
                          className={
                            resource.status === "running"
                              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
                              : ""
                          }
                        >
                          {resource.status}
                        </Badge>
                      </div>
                      <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                        <Globe className="h-3 w-3" />
                        <span>{resource.region}</span>
                        <span>•</span>
                        <Clock className="h-3 w-3" />
                        <span>
                          Last action:{" "}
                          {new Date(resource.lastAction).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {resource.tags.map((tag: any, index: number) => (
                          <Badge
                            key={index}
                            variant="outline"
                            className="text-xs"
                          >
                            {tag.key}={tag.value}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schedules" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Associated Schedules</CardTitle>
              <CardDescription>
                Cost optimization schedules targeting this account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {mockSchedules.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="flex items-start space-x-4 p-4 border rounded-lg"
                  >
                    <div className="flex-shrink-0 mt-1">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{schedule.name}</div>
                        <Badge
                          variant={schedule.active ? "default" : "secondary"}
                          className={
                            schedule.active
                              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
                              : ""
                          }
                        >
                          {schedule.active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {schedule.description}
                      </p>
                      <div className="flex items-center space-x-2 text-sm">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          Next execution:{" "}
                          {new Date(schedule.nextExecution).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {schedule.resourceTypes.map((type: string) => (
                          <Badge
                            key={type}
                            variant="secondary"
                            className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100"
                          >
                            {type}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>
                Recent actions and events for this account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {mockActivity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-start space-x-4 p-4 border rounded-lg"
                  >
                    <div className="flex-shrink-0 mt-1">
                      {getStatusIcon(activity.status)}
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{activity.action}</div>
                        <span className="text-sm text-muted-foreground">
                          {new Date(activity.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {activity.details}
                      </p>
                      {activity.resources > 0 && (
                        <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                          <Server className="h-3 w-3" />
                          <span>{activity.resources} resources affected</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Dialog */}
      {deletingAccount && (
        <DeleteAccountDialog
          account={account}
          open={deletingAccount}
          onOpenChange={setDeletingAccount}
        />
      )}
    </div>
  );
}
