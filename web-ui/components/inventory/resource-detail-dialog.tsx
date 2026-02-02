"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, ExternalLink, Server, Database, Cloud, Tag, Clock, MapPin, Box } from "lucide-react";
import { toast } from "sonner";

export interface ResourceDetailProps {
    resourceId: string;
    resourceArn: string;
    resourceType: string;
    name: string;
    region: string;
    state: string;
    accountId: string;
    lastDiscoveredAt: string;
    tags: Record<string, string>;
    metadata?: Record<string, any>;
}

interface ResourceDetailDialogProps {
    resource: ResourceDetailProps | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

// Helper to get AWS Console URL for the resource
const getAwsConsoleUrl = (resource: ResourceDetailProps): string | null => {
    const { resourceType, region, accountId, resourceId, resourceArn } = resource;
    const baseUrl = `https://${region}.console.aws.amazon.com`;

    switch (resourceType) {
        case "ec2_instances":
            return `${baseUrl}/ec2/home?region=${region}#Instances:instanceId=${resourceId}`;
        case "rds_instances":
            return `${baseUrl}/rds/home?region=${region}#database:id=${resourceId}`;
        case "ecs_services":
            // Extract cluster and service from ARN
            const ecsMatch = resourceArn.match(/cluster\/([^/]+)\/service\/([^/]+)/);
            if (ecsMatch) {
                return `${baseUrl}/ecs/v2/clusters/${ecsMatch[1]}/services/${ecsMatch[2]}?region=${region}`;
            }
            return `${baseUrl}/ecs/v2/clusters?region=${region}`;
        case "asg_groups":
            return `${baseUrl}/ec2autoscaling/home?region=${region}#/details/${resourceId}`;
        case "dynamodb_tables":
            return `${baseUrl}/dynamodb/home?region=${region}#table?name=${resourceId}`;
        case "docdb_instances":
            return `${baseUrl}/docdb/home?region=${region}#cluster-details/${resourceId}`;
        default:
            return null;
    }
};

// Helper to get friendly service name
const getServiceName = (resourceType: string): string => {
    const serviceMap: Record<string, string> = {
        ec2_instances: "EC2",
        rds_instances: "RDS",
        ecs_services: "ECS",
        asg_groups: "Auto Scaling",
        dynamodb_tables: "DynamoDB",
        docdb_instances: "DocumentDB",
    };
    return serviceMap[resourceType] || resourceType.replace(/_/g, " ").toUpperCase();
};

// Helper to get resource icon
const getResourceIcon = (type: string) => {
    if (type.includes("ec2") || type.includes("asg")) return <Server className="h-5 w-5" />;
    if (type.includes("rds") || type.includes("dynamo") || type.includes("docdb")) return <Database className="h-5 w-5" />;
    if (type.includes("ecs")) return <Box className="h-5 w-5" />;
    return <Cloud className="h-5 w-5" />;
};

// State badge component
const getStateBadge = (state: string) => {
    const stateColors: Record<string, string> = {
        running: "bg-green-500/10 text-green-500 border-green-500/20",
        stopped: "bg-red-500/10 text-red-500 border-red-500/20",
        available: "bg-blue-500/10 text-blue-500 border-blue-500/20",
        pending: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
        terminated: "bg-gray-500/10 text-gray-500 border-gray-500/20",
        active: "bg-green-500/10 text-green-500 border-green-500/20",
    };
    return (
        <Badge variant="outline" className={stateColors[state.toLowerCase()] || "bg-gray-500/10"}>
            {state}
        </Badge>
    );
};

export function ResourceDetailDialog({ resource, open, onOpenChange }: ResourceDetailDialogProps) {
    if (!resource) return null;

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text);
        toast.success(`${label} copied to clipboard`);
    };

    const awsConsoleUrl = getAwsConsoleUrl(resource);
    const serviceName = getServiceName(resource.resourceType);
    const tags = resource.tags || {};
    const metadata = resource.metadata || {};
    const hasMetadata = Object.keys(metadata).length > 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                            {getResourceIcon(resource.resourceType)}
                        </div>
                        <div className="flex-1 min-w-0">
                            <DialogTitle className="text-lg truncate">{resource.name}</DialogTitle>
                            <DialogDescription className="flex items-center gap-2 mt-1">
                                <Badge variant="secondary">{serviceName}</Badge>
                                {getStateBadge(resource.state)}
                            </DialogDescription>
                        </div>
                        {awsConsoleUrl && (
                            <Button variant="outline" size="sm" asChild>
                                <a href={awsConsoleUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="h-4 w-4 mr-2" />
                                    Open in AWS
                                </a>
                            </Button>
                        )}
                    </div>
                </DialogHeader>

                <Tabs defaultValue="details" className="flex-1 overflow-hidden flex flex-col">
                    <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="details">Details</TabsTrigger>
                        <TabsTrigger value="tags">Tags ({Object.keys(tags).length})</TabsTrigger>
                        <TabsTrigger value="metadata" disabled={!hasMetadata}>
                            Metadata
                        </TabsTrigger>
                    </TabsList>

                    <ScrollArea className="flex-1 mt-4">
                        <TabsContent value="details" className="mt-0 space-y-4">
                            {/* Basic Info */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-muted-foreground">Resource ID</label>
                                    <div className="flex items-center gap-2">
                                        <code className="text-sm bg-muted px-2 py-1 rounded truncate flex-1">
                                            {resource.resourceId}
                                        </code>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyToClipboard(resource.resourceId, "Resource ID")}>
                                            <Copy className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-muted-foreground">Account ID</label>
                                    <div className="flex items-center gap-2">
                                        <code className="text-sm bg-muted px-2 py-1 rounded truncate flex-1">
                                            {resource.accountId}
                                        </code>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyToClipboard(resource.accountId, "Account ID")}>
                                            <Copy className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Resource ARN</label>
                                <div className="flex items-center gap-2">
                                    <code className="text-xs bg-muted px-2 py-1 rounded truncate flex-1">
                                        {resource.resourceArn}
                                    </code>
                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyToClipboard(resource.resourceArn, "ARN")}>
                                        <Copy className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>

                            <Separator />

                            {/* Location & Status */}
                            <div className="grid grid-cols-3 gap-4">
                                <div className="flex items-start gap-3 p-3 rounded-lg border">
                                    <MapPin className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                                    <div>
                                        <div className="text-sm font-medium">Region</div>
                                        <div className="text-sm text-muted-foreground">{resource.region}</div>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 rounded-lg border">
                                    <Box className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                                    <div>
                                        <div className="text-sm font-medium">Service</div>
                                        <div className="text-sm text-muted-foreground">{serviceName}</div>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-3 rounded-lg border">
                                    <Clock className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                                    <div>
                                        <div className="text-sm font-medium">Last Discovered</div>
                                        <div className="text-sm text-muted-foreground">
                                            {resource.lastDiscoveredAt
                                                ? new Date(resource.lastDiscoveredAt).toLocaleString()
                                                : "Never"}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="tags" className="mt-0">
                            {Object.keys(tags).length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                                    <Tag className="h-8 w-8 mb-2" />
                                    <p>No tags found for this resource</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {Object.entries(tags).map(([key, value]) => (
                                        <div key={key} className="flex items-center justify-between p-3 rounded-lg border">
                                            <div className="flex items-center gap-2">
                                                <Tag className="h-4 w-4 text-muted-foreground" />
                                                <span className="font-medium text-sm">{key}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm text-muted-foreground">{value}</span>
                                                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(value, key)}>
                                                    <Copy className="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="metadata" className="mt-0">
                            {!hasMetadata ? (
                                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                                    <Database className="h-8 w-8 mb-2" />
                                    <p>No metadata available</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <div className="flex justify-end">
                                        <Button variant="outline" size="sm" onClick={() => copyToClipboard(JSON.stringify(metadata, null, 2), "Metadata")}>
                                            <Copy className="h-4 w-4 mr-2" />
                                            Copy JSON
                                        </Button>
                                    </div>
                                    <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-[400px]">
                                        {JSON.stringify(metadata, null, 2)}
                                    </pre>
                                </div>
                            )}
                        </TabsContent>
                    </ScrollArea>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
