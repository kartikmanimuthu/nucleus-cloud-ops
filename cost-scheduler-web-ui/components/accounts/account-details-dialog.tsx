"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import {
  Server,
  Shield,
  Globe,
  Calendar,
  DollarSign,
  Tag,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Clock,
} from "lucide-react"

interface AccountDetailsDialogProps {
  account: any
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Mock resource data
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
]

// Mock schedule data
const mockSchedules = [
  {
    id: "sch-001",
    name: "Production DB Shutdown",
    description: "Shutdown non-critical production databases during off-hours",
    active: true,
    nextExecution: "2024-01-16T22:00:00Z",
    resourceTypes: ["RDS"],
  },
  {
    id: "sch-002",
    name: "Dev Environment Cleanup",
    description: "Stop all development EC2 instances overnight",
    active: true,
    nextExecution: "2024-01-16T20:00:00Z",
    resourceTypes: ["EC2"],
  },
]

// Mock activity data
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
]

export function AccountDetailsDialog({ account, open, onOpenChange }: AccountDetailsDialogProps) {
  const validateConnection = () => {
    console.log("Validating connection for account:", account.id)
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "connected":
        return <CheckCircle className="h-4 w-4 text-success" />
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-warning" />
      case "success":
        return <CheckCircle className="h-4 w-4 text-success" />
      default:
        return <AlertTriangle className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "connected":
        return (
          <Badge variant="default" className="bg-success/10 text-green-800">
            Connected
          </Badge>
        )
      case "error":
        return <Badge variant="destructive">Connection Error</Badge>
      case "warning":
        return (
          <Badge variant="secondary" className="bg-warning/10 text-yellow-800">
            Warning
          </Badge>
        )
      case "success":
        return (
          <Badge variant="default" className="bg-success/10 text-green-800">
            Success
          </Badge>
        )
      default:
        return <Badge variant="outline">Unknown</Badge>
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Server className="h-5 w-5" />
            <span>{account?.name}</span>
          </DialogTitle>
          <DialogDescription>AWS Account ID: {account?.accountId}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="resources">Resources</TabsTrigger>
            <TabsTrigger value="schedules">Schedules</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Status</CardTitle>
                  <Shield className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-2">
                    {getStatusIcon(account.connectionStatus)}
                    {getStatusBadge(account.connectionStatus)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Last validated: {new Date(account.lastValidated).toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Resources</CardTitle>
                  <Server className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{account.resourceCount}</div>
                  <p className="text-xs text-muted-foreground">managed resources</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Schedules</CardTitle>
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{account.schedulesCount}</div>
                  <p className="text-xs text-muted-foreground">active schedules</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Monthly Savings</CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-success dark:text-success">${account.monthlySavings}</div>
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
                        <span className="text-muted-foreground">Description:</span>
                        <span className="text-right max-w-[200px]">{account.description}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">IAM Role</h4>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Role ARN:</span>
                        <div className="mt-1 font-mono text-xs break-all">{account.roleArn}</div>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Connection Status:</span>
                        <div className="flex items-center space-x-2">
                          {getStatusIcon(account.connectionStatus)}
                          <span>{account.connectionStatus}</span>
                        </div>
                      </div>
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
                    {account.tags.map((tag: any, index: number) => (
                      <Badge key={index} variant="outline">
                        <Tag className="h-3 w-3 mr-1" />
                        {tag.key}={tag.value}
                      </Badge>
                    ))}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Metadata</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Created:</span>
                        <span>{new Date(account.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Created By:</span>
                        <span>{account.createdBy}</span>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Last Updated:</span>
                        <span>{new Date(account.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Updated By:</span>
                        <span>{account.updatedBy}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button onClick={validateConnection} variant="outline">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Validate Connection
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="resources" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Managed Resources</CardTitle>
                <CardDescription>Resources managed by cost optimization schedules</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {mockResources.map((resource) => (
                    <div key={resource.id} className="flex items-start space-x-4 p-4 border rounded-lg">
                      <div className="flex-shrink-0 mt-1">
                        <Badge
                          variant="outline"
                          className="bg-info/10 text-blue-800"
                        >
                          {resource.type}
                        </Badge>
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{resource.name}</div>
                          <Badge
                            variant={resource.status === "running" ? "default" : "secondary"}
                            className={
                              resource.status === "running"
                                ? "bg-success/10 text-green-800"
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
                          <span>Last action: {new Date(resource.lastAction).toLocaleString()}</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {resource.tags.map((tag: any, index: number) => (
                            <Badge key={index} variant="outline" className="text-xs">
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
                <CardDescription>Cost optimization schedules targeting this account</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {mockSchedules.map((schedule) => (
                    <div key={schedule.id} className="flex items-start space-x-4 p-4 border rounded-lg">
                      <div className="flex-shrink-0 mt-1">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{schedule.name}</div>
                          <Badge
                            variant={schedule.active ? "default" : "secondary"}
                            className={
                              schedule.active ? "bg-success/10 text-green-800" : ""
                            }
                          >
                            {schedule.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{schedule.description}</p>
                        <div className="flex items-center space-x-2 text-sm">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">
                            Next execution: {new Date(schedule.nextExecution).toLocaleString()}
                          </span>
                        </div>
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
                <CardDescription>Recent actions and events for this account</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {mockActivity.map((activity) => (
                    <div key={activity.id} className="flex items-start space-x-4 p-4 border rounded-lg">
                      <div className="flex-shrink-0 mt-1">{getStatusIcon(activity.status)}</div>
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{activity.action}</div>
                          <span className="text-sm text-muted-foreground">
                            {new Date(activity.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">{activity.details}</p>
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
      </DialogContent>
    </Dialog>
  )
}
