"use client";

import type React from "react";

import { useState, useEffect } from "react";
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
import { Server, Globe, CheckCircle, Loader2 } from "lucide-react";
import { ClientAccountService } from "@/lib/client-account-service";

interface EditAccountDialogProps {
  account: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountUpdated?: () => void; // Callback prop to notify parent component
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

export function EditAccountDialog({
  account,
  open,
  onOpenChange,
  onAccountUpdated, // Destructure callback prop
}: EditAccountDialogProps) {
  const [formData, setFormData] = useState({
    name: "",
    accountId: "",
    roleArn: "",
    description: "",
    regions: [] as string[],
    active: true,
  });

  const [isValidating, setIsValidating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (account) {
      setFormData({
        name: account.name || "",
        accountId: account.accountId || "",
        roleArn: account.roleArn || "",
        description: account.description || "",
        regions: account.regions || [],
        active: account.active ?? true,
      });
    }
  }, [account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!account?.id) return;

    if (formData.regions.length === 0) {
      alert("Please select at least one region");
      return;
    }

    try {
      setIsUpdating(true);
      await ClientAccountService.updateAccount(account.id, {
        name: formData.name,
        roleArn: formData.roleArn,
        description: formData.description,
        region: formData.regions[0] || 'ap-south-1', // Use first region
        tags: formData.regions, // Store all regions as tags for now
      });

      onOpenChange(false);
      setValidationResult(null);

      // Use callback instead of page reload for better UX
      if (onAccountUpdated) {
        onAccountUpdated();
      } else {
        // Fallback to page reload if callback not provided
        window.location.reload();
      }
    } catch (error: any) {
      console.error("Error updating account:", error);
      alert(error.message || "Failed to update account");
    } finally {
      setIsUpdating(false);
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
      } else {
        setValidationResult({
          success: false,
          message: result.error || "Connection validation failed",
        });
      }
    } catch (error) {
      setValidationResult({
        success: false,
        message: "Failed to validate connection",
      });
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit AWS Account</DialogTitle>
          <DialogDescription>
            Update the configuration for "{account?.name}"
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={formData.regions.length === 0 || isUpdating}
            >
              {isUpdating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Account"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
