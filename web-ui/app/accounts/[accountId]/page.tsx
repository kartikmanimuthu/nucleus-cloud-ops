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


interface AccountDetailPageProps {
  params: Promise<{
    accountId: string;
  }>;
}

// Types for fetched data
interface AccountSchedule {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  nextExecution?: string;
  resourceTypes?: string[];
}

interface AccountResource {
  id: string;
  type: 'ec2' | 'ecs' | 'rds' | 'asg';
  name: string;
  arn?: string;
  clusterArn?: string;
  schedules: string[];
}

interface AccountActivity {
  id: string;
  timestamp: string;
  action: string;
  details: string;
  status: string;
  resourceType?: string;
  resourceName?: string;
  metadata?: any;
}

export default function AccountDetailPage({ params }: AccountDetailPageProps) {
  const router = useRouter();
  const { accountId } = use(params);
  const [account, setAccount] = useState<UIAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validatingConnection, setValidatingConnection] = useState(false);
  
  // State for schedules, resources, and activity
  const [schedules, setSchedules] = useState<AccountSchedule[]>([]);
  const [resources, setResources] = useState<AccountResource[]>([]);
  const [activity, setActivity] = useState<AccountActivity[]>([]);
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [loadingResources, setLoadingResources] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // Pagination state for activity
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const totalPages = Math.ceil(activity.length / itemsPerPage);
  
  const paginatedActivity = activity.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(prev => prev + 1);
    }
  };

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(prev => prev - 1);
    }
  };

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

  const loadSchedules = async () => {
    try {
      setLoadingSchedules(true);
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/schedules`);
      if (response.ok) {
        const data = await response.json();
        setSchedules(data.schedules || []);
      }
    } catch (err) {
      console.error("Error loading schedules:", err);
    } finally {
      setLoadingSchedules(false);
    }
  };

  const loadResources = async () => {
    try {
      setLoadingResources(true);
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/resources`);
      if (response.ok) {
        const data = await response.json();
        setResources(data.resources || []);
      }
    } catch (err) {
      console.error("Error loading resources:", err);
    } finally {
      setLoadingResources(false);
    }
  };

  const loadActivity = async () => {
    try {
      setLoadingActivity(true);
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/activity`);
      if (response.ok) {
        const data = await response.json();
        setActivity(data.activity || []);
      }
    } catch (err) {
      console.error("Error loading activity:", err);
    } finally {
      setLoadingActivity(false);
    }
  };

  useEffect(() => {
    loadAccount();
    loadSchedules();
    loadResources();
    loadActivity();

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
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "inactive":
        return <XCircle className="h-4 w-4 text-muted-foreground" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      case "success":
        return <CheckCircle className="h-4 w-4 text-success" />;
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
      case "success":
        return (
          <Badge
            variant="default"
            className="bg-success/10 text-green-800"
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
          </Button>        </div>
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
                <div className="text-2xl font-bold text-success dark:text-success">
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
                        <div className="mt-2 p-2 bg-destructive/10 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
                             <p className="text-xs text-destructive dark:text-destructive font-mono">
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
              {loadingResources ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : resources.length === 0 ? (
                <div className="text-center py-8">
                  <Server className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-2 text-sm font-semibold">No resources found</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    No resources are managed by schedules for this account yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {resources.map((resource) => (
                    <div
                      key={resource.id}
                      className="flex items-start space-x-4 p-4 border rounded-lg"
                    >
                      <div className="flex-shrink-0 mt-1">
                        <Badge
                          variant="outline"
                          className="bg-info/10 text-blue-800"
                        >
                          {resource.type.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{resource.name}</div>
                        </div>
                        {resource.arn && (
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {resource.arn}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1">
                          <span className="text-xs text-muted-foreground">Used in schedules:</span>
                          {resource.schedules.map((scheduleName: string) => (
                            <Badge
                              key={scheduleName}
                              variant="outline"
                              className="text-xs"
                            >
                              {scheduleName}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
              {loadingSchedules ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : schedules.length === 0 ? (
                <div className="text-center py-8">
                  <Calendar className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-2 text-sm font-semibold">No schedules found</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    No cost optimization schedules are targeting this account yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {schedules.map((schedule) => (
                    <div
                      key={schedule.id}
                      className="flex items-start space-x-4 p-4 border rounded-lg"
                    >
                      <div className="flex-shrink-0 mt-1">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => router.push(`/schedules/${encodeURIComponent(schedule.id)}`)}
                            className="font-medium text-left hover:text-primary hover:underline transition-colors cursor-pointer"
                          >
                            {schedule.name}
                          </button>
                          <Badge
                            variant={schedule.active ? "default" : "secondary"}
                            className={
                              schedule.active
                                ? "bg-success/10 text-green-800"
                                : ""
                            }
                          >
                            {schedule.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {schedule.description || "No description"}
                        </p>
                        {schedule.nextExecution && (
                          <div className="flex items-center space-x-2 text-sm">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              Next execution:{" "}
                              {new Date(schedule.nextExecution).toLocaleString()}
                            </span>
                          </div>
                        )}
                        {schedule.resourceTypes && schedule.resourceTypes.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {schedule.resourceTypes.map((type: string) => (
                              <Badge
                                key={type}
                                variant="secondary"
                                className="text-xs bg-info/10 text-blue-800"
                              >
                                {type}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
              {loadingActivity ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : activity.length === 0 ? (
                <div className="text-center py-8">
                  <Clock className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-2 text-sm font-semibold">No recent activity</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    No recent actions or events for this account.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {paginatedActivity.map((activityItem) => (
                    <div
                      key={activityItem.id}
                      className="flex items-start space-x-4 p-4 border rounded-lg"
                    >
                      <div className="flex-shrink-0 mt-1">
                        {getStatusIcon(activityItem.status)}
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{activityItem.action}</div>
                          <span className="text-sm text-muted-foreground">
                            {new Date(activityItem.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {activityItem.details}
                        </p>
                        {activityItem.resourceType && (
                          <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                            <Server className="h-3 w-3" />
                            <span>{activityItem.resourceType}: {activityItem.resourceName}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* Pagination Controls */}
              {activity.length > 0 && (
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm text-muted-foreground">
                    Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, activity.length)} of {activity.length} entries
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevPage}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </Button>
                    <div className="text-sm font-medium">
                      Page {currentPage} of {totalPages || 1}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={currentPage >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  );
}
