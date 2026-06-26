"use client";

import type React from "react";

import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Globe, CheckCircle, Loader2, Shield } from "lucide-react";
import { ClientAccountService } from "@/lib/client-account-service";
import { useToast } from "@/hooks/use-toast";

interface CreateAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountCreated?: () => void;
}

const awsRegions = [
  { id: "us-east-1", name: "US East (N. Virginia)" },
  { id: "us-east-2", name: "US East (Ohio)" },
  { id: "us-west-1", name: "US West (N. California)" },
  { id: "us-west-2", name: "US West (Oregon)" },
  { id: "eu-west-1", name: "Europe (Ireland)" },
  { id: "eu-west-2", name: "Europe (London)" },
  { id: "eu-central-1", name: "Europe (Frankfurt)" },
  { id: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { id: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
];

export function CreateAccountDialog({
  open,
  onOpenChange,
  onAccountCreated,
}: CreateAccountDialogProps) {
  const { data: session } = useSession();
  const [formData, setFormData] = useState({
    name: "",
    accountId: "",
    roleArn: "",
    description: "",
    regions: [] as string[],
    active: true,
  });

  const [isValidating, setIsValidating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.regions.length === 0) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select at least one region.",
      });
      return;
    }

    try {
      setIsCreating(true);
      await ClientAccountService.createAccount({
        name: formData.name,
        accountId: formData.accountId,
        roleArn: formData.roleArn,
        description: formData.description,
        regions: formData.regions,
        active: formData.active,
        createdBy: session?.user?.email || "user", // Get from auth context
        updatedBy: "user",
      });

      toast({
        variant: "success",
        title: "Account Created",
        description: `Account "${formData.name}" created successfully.`,
      });

      onOpenChange(false);
      // Reset form
      setFormData({
        name: "",
        accountId: "",
        roleArn: "",
        description: "",
        regions: [],
        active: true,
      });
      setValidationResult(null);

      // Use callback instead of page reload for better UX
      if (onAccountCreated) {
        onAccountCreated();
      }
    } catch (error: any) {
      console.error("Error creating account:", error);
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error.message || "Failed to create account.",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleRegionToggle = (regionId: string) => {
    setFormData((prev) => ({
      ...prev,
      regions: prev.regions.includes(regionId)
        ? prev.regions.filter((r) => r !== regionId)
        : [...prev.regions, regionId],
    }));
  };

  const validateConnection = async () => {
    if (!formData.accountId || !formData.roleArn) {
      setValidationResult({
        success: false,
        message: "Please provide both Account ID and Role ARN",
      });
      return;
    }

    setIsValidating(true);
    setValidationResult(null);

    try {
      // Implement actual validation API call
      const response = await fetch(`/api/accounts/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountId: formData.accountId,
          roleArn: formData.roleArn,
          regions: formData.regions,
        }),
      });

      const result = await response.json();

      if (response.ok && result.valid) {
        setValidationResult({
          success: true,
          message: "Connection validated successfully",
        });
        toast({
          variant: "success",
          title: "Connection Validated",
          description: "Account connection validated successfully.",
        });
      } else {
        setValidationResult({
          success: false,
          message: result.error || "Connection validation failed",
        });
        toast({
          variant: "destructive",
          title: "Validation Failed",
          description: result.error || "Unable to validate account connection.",
        });
      }
    } catch (error: any) {
      setValidationResult({
        success: false,
        message: error.message || "Connection validation failed",
      });
      toast({
        variant: "destructive",
        title: "Validation Failed",
        description: error.message || "Connection validation failed.",
      });
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add AWS Account</DialogTitle>
          <DialogDescription>
            Add a new AWS account for cost optimization scheduling
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Server className="h-4 w-4" />
                <span>Account Information</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Account Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="e.g., Production Account"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="accountId">AWS Account ID *</Label>
                  <Input
                    id="accountId"
                    value={formData.accountId}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        accountId: e.target.value,
                      }))
                    }
                    placeholder="123456789012"
                    pattern="[0-9]{12}"
                    maxLength={12}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="roleArn">IAM Role ARN *</Label>
                <Input
                  id="roleArn"
                  value={formData.roleArn}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      roleArn: e.target.value,
                    }))
                  }
                  placeholder={`arn:aws:iam::123456789012:role/NucleusAccess-${process.env.NEXT_PUBLIC_HUB_ACCOUNT_ID || 'HUB_ACCOUNT_ID'}`}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  The IAM role that allows cross-account access for cost
                  optimization
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Optional description for this account..."
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="active">Status</Label>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="active"
                    checked={formData.active}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({ ...prev, active: checked }))
                    }
                  />
                  <Label htmlFor="active">
                    {formData.active ? "Active" : "Inactive"}
                  </Label>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Globe className="h-4 w-4" />
                <span>AWS Regions</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label>Select regions to manage *</Label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {awsRegions.map((region) => (
                    <div
                      key={region.id}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={region.id}
                        checked={formData.regions.includes(region.id)}
                        onCheckedChange={() => handleRegionToggle(region.id)}
                      />
                      <Label htmlFor={region.id} className="text-sm">
                        <div className="font-medium">{region.id}</div>
                        <div className="text-xs text-muted-foreground">
                          {region.name}
                        </div>
                      </Label>
                    </div>
                  ))}
                </div>
                {formData.regions.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm text-muted-foreground mb-2">
                      Selected regions:
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {formData.regions.map((regionId) => (
                        <Badge
                          key={regionId}
                          variant="secondary"
                          className="text-xs"
                        >
                          {regionId}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connection Validation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center space-x-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={validateConnection}
                  disabled={
                    isValidating || !formData.accountId || !formData.roleArn
                  }
                >
                  {isValidating ? (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4 animate-spin" />
                      Validating...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Test Connection
                    </>
                  )}
                </Button>
                <p className="text-sm text-muted-foreground">
                  Verify that the role can be assumed and has required
                  permissions
                </p>
              </div>

              {validationResult && (
                <div
                  className={`p-3 rounded-lg border ${validationResult.success
                    ? "bg-success/10 border-green-200 text-green-800"
                    : "bg-destructive/10 border-red-200 text-red-800"
                    }`}
                >
                  <div className="flex items-center space-x-2">
                    {validationResult.success ? (
                      <CheckCircle className="h-4 w-4 text-success" />
                    ) : (
                      <CheckCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span className="text-sm font-medium">
                      {validationResult.message}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

            {/* Setup Instructions Section */}
            <Card className="bg-muted/50 border-dashed">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center">
                        <Shield className="h-4 w-4 mr-2" />
                        Prerequisites: Cross-Account Role
                    </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground space-y-3">
                    <p>
                        To allow Nucleus to manage costs, you must create an IAM role in the target account.
                        Download the CloudFormation template below and deploy it in the target account.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-8"
                            onClick={() => {
                                const fileName = `${formData.accountId || 'nucleus'}_${formData.name?.replace(/\s+/g, '_') || 'integration'}.yaml`;
                                const link = document.createElement('a');
                                link.href = '/templates/nucleus-account-integration.yaml';
                                link.download = fileName;
                                document.body.appendChild(link);
                                link.click();
                                document.body.removeChild(link);
                            }}
                        >
                            <Server className="h-3 w-3 mr-2" />
                            Download YAML
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-8"
                            onClick={() => {
                                const fileName = `${formData.accountId || 'nucleus'}_${formData.name?.replace(/\s+/g, '_') || 'integration'}.json`;
                                const link = document.createElement('a');
                                link.href = '/templates/nucleus-account-integration.json';
                                link.download = fileName;
                                document.body.appendChild(link);
                                link.click();
                                document.body.removeChild(link);
                            }}
                        >
                            <Server className="h-3 w-3 mr-2" />
                            Download JSON
                        </Button>
                    </div>
                </CardContent>
            </Card>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={formData.regions.length === 0 || isCreating}
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Add Account"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
