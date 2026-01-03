"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { 
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue, 
} from "@/components/ui/select";
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
import { Save, Loader2, AlertCircle, Copy, Check, ChevronDown, Terminal, Download, FileCode, FileJson } from "lucide-react";
import { ClientAccountService } from "@/lib/client-account-service";

const createAccountSchema = z.object({
  accountId: z
    .string()
    .min(12, "Account ID must be 12 digits")
    .max(12, "Account ID must be 12 digits")
    .regex(/^\d+$/, "Account ID must contain only numbers"),
  name: z
    .string()
    .min(1, "Account name is required")
    .max(100, "Account name must be less than 100 characters"),
  roleArn: z
    .string()
    .min(1, "Role ARN is required")
    .regex(/^arn:aws:iam::\d{12}:role\/.*/, "Invalid Role ARN format"),
  externalId: z.string().min(1, "External ID is required"),
  description: z.string().optional(),
  region: z.string().min(1, "Region is required"),
  // Active is removed from UI but we default it to true in submission
});

type CreateAccountFormValues = z.infer<typeof createAccountSchema>;

const AWS_REGIONS = [
  { id: "us-east-1", name: "US East (N. Virginia)" },
  { id: "us-east-2", name: "US East (Ohio)" },
  { id: "us-west-1", name: "US West (N. California)" },
  { id: "us-west-2", name: "US West (Oregon)" },
  { id: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { id: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { id: "eu-west-1", name: "Europe (Ireland)" },
  { id: "eu-central-1", name: "Europe (Frankfurt)" },
];

export interface CreateAccountFormProps {
  hubAccountId: string;
}

export function CreateAccountForm({ hubAccountId }: CreateAccountFormProps) {
  const { data: session } = useSession(); // Get session
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [templateYaml, setTemplateYaml] = useState<string | null>(null);
  const [isTemplateOpen, setIsTemplateOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const form = useForm<CreateAccountFormValues>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: {
      accountId: "",
      name: "",
      roleArn: "",
      externalId: "",
      description: "",
      region: "ap-south-1",
    },
  });

  const accountId = form.watch("accountId");
  const accountName = form.watch("name");

  const generateTemplate = async () => {
    if (!accountId || accountId.length !== 12) {
      alert("Please enter a valid 12-digit AWS Account ID first.");
      return;
    }

    try {
      setGenerating(true);
      // hubAccountId is now passed as prop
      
      const response = await fetch(`/api/accounts/template?targetAccountId=${accountId}&accountName=${encodeURIComponent(accountName || '')}&hubAccountId=${hubAccountId}`);
      if (!response.ok) throw new Error("Failed to generate template");
      
      const data = await response.json();
      
      if (data.template) {
          setTemplate(JSON.stringify(data.template, null, 2));
      }
      if (data.templateYaml) {
          setTemplateYaml(data.templateYaml);
      }
      
      setIsTemplateOpen(true);

          if (data.externalId) {
             form.setValue("externalId", data.externalId);
           
             // Use the backend-generated role ARN
             if (data.suggestedRoleArn && !form.getValues("roleArn")) {
               form.setValue("roleArn", data.suggestedRoleArn);
             }
          }
    } catch (error) {
      console.error("Error generating template:", error);
      alert("Failed to generate template.");
    } finally {
      setGenerating(false);
    }
  };

  const copyToClipboard = () => {
      if (!template) return;
      navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
  };

  const downloadFile = (format: 'yaml' | 'json') => {
      const fileName = `${accountId || 'nucleus'}_${accountName?.replace(/\s+/g, '_') || 'integration'}.${format}`;
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
          alert("Please generate the template first.");
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

  const onSubmit = async (data: CreateAccountFormValues) => {
    try {
      setLoading(true);

      await ClientAccountService.createAccount({
        accountId: data.accountId,
        name: data.name,
        roleArn: data.roleArn,
        externalId: data.externalId,
        regions: [data.region], 
        active: true, // Default to active on creation
        description: data.description || "",
        createdBy: session?.user?.email || "web-ui-user",
        updatedBy: session?.user?.email || "web-ui-user",
      });

      router.push("/accounts");
    } catch (error) {
      console.error("Failed to create account:", error);
      alert("Failed to create account. Check console for details.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5" />
              <span>Account Configuration</span>
            </CardTitle>
            <CardDescription>
              Configure the basic AWS account details and generate the onboarding template
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Row 1: Account ID and Region */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                    control={form.control}
                    name="accountId"
                    render={({ field }) => (
                    <FormItem>
                        <FormLabel>AWS Account ID</FormLabel>
                        <FormControl>
                        <Input
                            {...field}
                            placeholder="123456789012"
                            maxLength={12}
                        />
                        </FormControl>
                        <FormDescription>
                        The 12-digit ID of the target account
                        </FormDescription>
                        <FormMessage />
                    </FormItem>
                    )}
                />

                <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>Region</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                        <SelectTrigger>
                            <SelectValue placeholder="Select a region" />
                        </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                        {AWS_REGIONS.map((region) => (
                            <SelectItem key={region.id} value={region.id}>
                            {region.name} ({region.id})
                            </SelectItem>
                        ))}
                        </SelectContent>
                    </Select>
                    <FormDescription>
                        Region for the CloudFormation stack
                    </FormDescription>
                    <FormMessage />
                    </FormItem>
                )}
                />
            </div>

            {/* Row 2: Account Name and Description */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                    <FormItem>
                        <FormLabel>Account Name</FormLabel>
                        <FormControl>
                        <Input {...field} placeholder="Production Account" />
                        </FormControl>
                        <FormDescription>
                        Friendly name for this account
                        </FormDescription>
                        <FormMessage />
                    </FormItem>
                    )}
                />

                <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>Description (Optional)</FormLabel>
                    <FormControl>
                        <Input // Changed from Textarea to Input to align nicely next to name
                        {...field}
                        placeholder="Description..."
                        />
                    </FormControl>
                    <FormDescription>
                        Brief description
                    </FormDescription>
                    <FormMessage />
                    </FormItem>
                )}
                />
            </div>

            {/* Template Generation Section */}
            <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex-1 mr-4">
                            <h3 className="text-sm font-medium text-slate-900">CloudFormation Template</h3>
                            <p className="text-xs text-slate-500 mt-1">
                                Generate the template to deploy in the account {accountId ? `(${accountId})` : ''}
                            </p>
                        </div>
                        <div className="flex space-x-2">
                             {!template ? (
                                <Button 
                                    type="button" 
                                    onClick={generateTemplate}
                                    disabled={generating || !accountId || accountId.length !== 12}
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
                            <CollapsibleContent className="space-y-2">
                                <div className="rounded-md bg-slate-950 p-4 overflow-x-auto max-h-[300px]">
                                    <pre className="text-xs text-slate-50 font-mono">
                                        <code>{template}</code>
                                    </pre>
                                </div>
                                <p className="text-xs text-slate-500">
                                    Deploy this stack in {form.getValues("region")}.
                                </p>
                            </CollapsibleContent>
                        </Collapsible>
                    )}
                </div>
            </div>

            {/* Row 3: Role ARN and External ID */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                control={form.control}
                name="roleArn"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>Cross-Account Role ARN</FormLabel>
                    <FormControl>
                        <Input
                        {...field}
                        placeholder={`arn:aws:iam::123456789012:role/NucleusAccess-${hubAccountId || 'HUB_ACCOUNT_ID'}`}
                        />
                    </FormControl>
                    <FormDescription>
                        Stack Output: `RoleArn`
                    </FormDescription>
                    <FormMessage />
                    </FormItem>
                )}
                />

                <FormField
                control={form.control}
                name="externalId"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>External ID</FormLabel>
                    <FormControl>
                        <Input
                        {...field}
                        placeholder="Generated External ID"
                        readOnly
                        className="bg-slate-50 font-mono text-xs"
                        />
                    </FormControl>
                    <FormDescription>
                       Passed to template as `ExternalId`
                    </FormDescription>
                    <FormMessage />
                    </FormItem>
                )}
                />
            </div>

          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-end space-x-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" />
            Create Account
          </Button>
        </div>
      </form>
    </Form>
  );
}
