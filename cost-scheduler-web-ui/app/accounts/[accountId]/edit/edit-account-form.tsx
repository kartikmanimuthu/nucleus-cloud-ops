"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Save,
  Server,
  Globe,
  CheckCircle,
  Loader2,
  AlertTriangle,
  Copy,
  Check,
  ChevronDown,
  Terminal,
  Download,
  FileCode,
  FileJson,
} from "lucide-react";
import { UIAccount } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { ClientAccountService } from "@/lib/client-account-service";

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

interface EditAccountFormProps {
  account: UIAccount;
  hubAccountId: string;
}

export function EditAccountForm({ account, hubAccountId }: EditAccountFormProps) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    name: "",
    accountId: "",
    roleArn: "",
    externalId: "",
    description: "",
    regions: [] as string[],
    active: true,
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Template state
  const [generating, setGenerating] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [templateYaml, setTemplateYaml] = useState<string | null>(null); 
  const [isTemplateOpen, setIsTemplateOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Update form data when account changes
  useEffect(() => {
    if (account) {
      console.log("Updating form data with account:", account);
      setFormData({
        name: account.name || "",
        accountId: account.accountId || "",
        roleArn: account.roleArn || "",
        externalId: account.externalId || "",
        description: account.description || "",
        regions: account.regions || [],
        active: account.active ?? true,
      });
    }
  }, [account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    try {
      setIsSubmitting(true);

      // Update the account (excluding name as it cannot be changed)
      await ClientAccountService.updateAccount(account.accountId, {
        roleArn: formData.roleArn,
        description: formData.description,
        regions: formData.regions,
        active: formData.active,
        updatedBy: session?.user?.email || "web-ui-user",
      });

      toast({
        variant: "success",
        title: "Account Updated",
        description: "Account configuration updated successfully.",
      });

      // Navigate back to account view
      router.push(`/accounts`);
    } catch (error: any) {
      console.error("Error updating account:", error);
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "Failed to update account.",
      });
    } finally {
      setIsSubmitting(false);
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
        // Use Client Service for validation!
      await ClientAccountService.validateAccount({
          accountId: formData.accountId,
          roleArn: formData.roleArn,
          externalId: formData.externalId,
          region: formData.regions[0] || 'us-east-1'
      });
      setValidationResult({
        success: true,
        message: "Connection validated successfully",
      });
      toast({
        variant: "success",
        title: "Connection Validated",
        description: "Account connection validated successfully.",
      });
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

  const generateTemplate = async () => {
    // Basic validation
    if (!formData.accountId || formData.accountId.length !== 12) {
      toast({
        variant: "destructive",
        title: "Invalid Account ID",
        description: "Please enter a valid 12-digit AWS Account ID first.",
      });
      return;
    }

    try {
      setGenerating(true);
      const response = await fetch('/api/accounts/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            accountId: formData.accountId,
            accountName: formData.name, 
            region: formData.regions[0] || 'us-east-1',
            externalId: formData.externalId // Pass existing external ID to maintain consistency
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to generate template');
      }

      setTemplate(JSON.stringify(data.template, null, 2));
      if (data.templateYaml) setTemplateYaml(data.templateYaml);
      setIsTemplateOpen(true);
      
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to generate template",
      });
    } finally {
        setGenerating(false);
    }
  };

  const copyToClipboard = () => {
    if (template) {
      navigator.clipboard.writeText(template);
      setCopied(true);
      toast({
        title: "Copied",
        description: "CloudFormation template copied to clipboard",
      });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadFile = (format: 'yaml' | 'json') => {
      const fileName = `${formData.accountId || 'nucleus'}_${formData.name?.replace(/\s+/g, '_') || 'integration'}.${format}`;
      let content = '';
      let type = '';

      if (format === 'json') {
          content = template || ''; // Already stringified
          type = 'application/json';
      } else {
          content = templateYaml || '';
          type = 'text/yaml';
      }

      if (!content) {
          toast({ variant: "destructive", title: "Generate Template", description: "Please generate the template first." });
          return;
      }

      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <form id="edit-account-form" onSubmit={handleSubmit} className="space-y-8">
        
        {/* Account Configuration Card */}
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                    <Server className="h-5 w-5" />
                    <span>Account Configuration</span>
                </CardTitle>
                <CardDescription>
                    Update the account settings and cross-account role
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                
                {/* Row 1: ID and Status */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="accountId">AWS Account ID</Label>
                        <Input
                            id="accountId"
                            value={formData.accountId}
                            disabled
                            className="bg-muted font-mono"
                        />
                        <p className="text-[0.8rem] text-muted-foreground">
                            The 12-digit ID of the target account
                        </p>
                    </div>

                     <div className="space-y-2">
                        <Label>Status</Label>
                         <div className="flex items-center space-x-2 h-10 border rounded-md px-3">
                            <Switch
                                id="active"
                                checked={formData.active}
                                onCheckedChange={(checked) =>
                                    setFormData((prev) => ({ ...prev, active: checked }))
                                }
                            />
                            <Label htmlFor="active" className="cursor-pointer">
                                {formData.active ? "Active" : "Inactive"}
                            </Label>
                        </div>
                        <p className="text-[0.8rem] text-muted-foreground">
                            Enable or disable this account
                        </p>
                    </div>
                </div>

                {/* Row 2: Name and Description */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                         <Label htmlFor="name">Account Name</Label>
                        <Input
                            id="name"
                            value={formData.name}
                            disabled
                            className="bg-muted"
                        />
                        <p className="text-[0.8rem] text-muted-foreground">
                            Friendly name (cannot be changed)
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="description">Description (Optional)</Label>
                        <Input
                            id="description"
                            value={formData.description}
                            onChange={(e) =>
                                setFormData((prev) => ({
                                    ...prev,
                                    description: e.target.value,
                                }))
                            }
                            placeholder="Description..."
                        />
                        <p className="text-[0.8rem] text-muted-foreground">
                            Brief description
                        </p>
                    </div>
                </div>

                 {/* Template Section */}
                 <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-col space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex-1 mr-4">
                                <h3 className="text-sm font-medium text-slate-900">CloudFormation Template</h3>
                                <p className="text-xs text-slate-500 mt-1">
                                    Generate the template to deploy in the account {formData.accountId ? `(${formData.accountId})` : ''}
                                </p>
                            </div>
                        <div className="flex space-x-2">
                             {!template ? (
                                <Button 
                                    type="button" 
                                    onClick={generateTemplate}
                                    disabled={generating || !formData.accountId}
                                >
                                    {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Generate Template
                                </Button>
                             ) : (
                                <>
                                    <Button 
                                        type="button" 
                                        variant="ghost"
                                        size="sm"
                                        onClick={generateTemplate}
                                        disabled={generating}
                                    >
                                        {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Terminal className="mr-2 h-4 w-4" />}
                                        Regenerate
                                    </Button>

                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="default" size="sm">
                                                <Download className="mr-2 h-4 w-4" />
                                                Download
                                                <ChevronDown className="ml-2 h-3 w-3 opacity-50" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => downloadFile('yaml')}>
                                                <FileCode className="mr-2 h-4 w-4" />
                                                <span>YAML Template</span>
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => downloadFile('json')}>
                                                <FileJson className="mr-2 h-4 w-4" />
                                                <span>JSON Template</span>
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </>
                             )}
                        </div>
                        </div>

                        {template && (
                            <Collapsible
                                open={isTemplateOpen}
                                onOpenChange={setIsTemplateOpen}
                                className="w-full space-y-2"
                            >
                                <div className="flex items-center justify-between space-x-4 px-1 bg-white p-2 rounded border">
                                    <CollapsibleTrigger asChild>
                                        <Button variant="ghost" size="sm" className="w-9 p-0">
                                            <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isTemplateOpen ? "" : "-rotate-90"}`} />
                                            <span className="sr-only">Toggle</span>
                                        </Button>
                                    </CollapsibleTrigger>
                                    <span className="text-xs text-muted-foreground flex-1 font-mono">
                                        template.json
                                    </span>
                                    <Button type="button" size="sm" variant="ghost" onClick={copyToClipboard} className="h-8">
                                        {copied ? (
                                            <Check className="mr-2 h-3.5 w-3.5 text-success" />
                                        ) : (
                                            <Copy className="mr-2 h-3.5 w-3.5" />
                                        )}
                                        {copied ? "Copied" : "Copy"}
                                    </Button>
                                </div>
                                <CollapsibleContent>
                                    <div className="rounded-md bg-slate-950 p-4 overflow-auto max-h-[400px]">
                                        <pre className="text-xs text-slate-50 font-mono">
                                            {template}
                                        </pre>
                                    </div>
                                </CollapsibleContent>
                            </Collapsible>
                        )}
                    </div>
                </div>

                {/* Role ARN and External ID */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     <div className="space-y-2">
                        <Label htmlFor="roleArn">Cross-Account Role ARN</Label>
                        <Input
                            id="roleArn"
                            value={formData.roleArn}
                            onChange={(e) =>
                                setFormData((prev) => ({ ...prev, roleArn: e.target.value }))
                            }
                            placeholder={`arn:aws:iam::123456789012:role/NucleusAccess-${hubAccountId || 'HUB_ACCOUNT_ID'}`}
                        />
                         <p className="text-[0.8rem] text-muted-foreground">
                            Stack Output: 'RoleArn'
                        </p>
                    </div>

                     <div className="space-y-2">
                        <Label htmlFor="externalId">External ID</Label>
                        <Input
                            id="externalId"
                            value={formData.externalId}
                            readOnly
                            className="bg-muted font-mono"
                        />
                        <p className="text-[0.8rem] text-muted-foreground">
                             Passed to template as 'ExternalId'
                        </p>
                    </div>
                </div>

            </CardContent>
        </Card>

        {/* AWS Regions Card - Keeping separate as it handles multiple items */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Globe className="h-5 w-5" />
              <span>AWS Regions</span>
            </CardTitle>
            <CardDescription>
                Select the regions you want to manage cost optimization for
            </CardDescription>
          </CardHeader>
          <CardContent>
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-md p-4">
                {awsRegions.map((region) => (
                  <div key={region.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={region.id}
                      checked={formData.regions.includes(region.id)}
                      onCheckedChange={() => handleRegionToggle(region.id)}
                    />
                    <Label htmlFor={region.id} className="text-sm cursor-pointer">
                      <div className="font-medium">{region.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {region.name}
                      </div>
                    </Label>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                  <p className="text-sm text-muted-foreground mb-2">
                    Selected regions:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {formData.regions.length > 0 ? formData.regions.map((regionId) => (
                      <Badge
                        key={regionId}
                        variant="secondary"
                        className="text-xs"
                      >
                        {regionId}
                      </Badge>
                    )) : (
                        <span className="text-xs text-muted-foreground italic">No regions selected</span>
                    )}
                  </div>
                </div>
          </CardContent>
        </Card>

        {/* Connection Validation Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
                <Terminal className="h-5 w-5" />
                <span>Connection Validation</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center space-x-4">
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Validating...
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Test Connection
                  </>
                )}
              </Button>
               {validationResult && (
                    <div className={`flex items-center space-x-2 px-3 py-2 rounded-md border ${
                        validationResult.success 
                        ? "bg-success/10 border-green-200 text-green-700" 
                        : "bg-destructive/10 border-red-200 text-red-700"
                    }`}>
                        {validationResult.success ? (
                            <CheckCircle className="h-4 w-4" />
                        ) : (
                            <AlertTriangle className="h-4 w-4" />
                        )}
                        <span className="text-sm font-medium">
                            {validationResult.message}
                        </span>
                    </div>
                )}
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex justify-end space-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              router.push(`/accounts/${encodeURIComponent(account.accountId)}`)
            }
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || formData.regions.length === 0}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
