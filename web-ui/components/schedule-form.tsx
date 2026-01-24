"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Clock, Calendar, Save, Loader2, Server, RefreshCw, Check, ChevronsUpDown } from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount, Schedule, UISchedule } from "@/lib/types";
import { cn } from "@/lib/utils";

const scheduleFormSchema = z.object({
  name: z.string().min(1, "Schedule name is required"),
  starttime: z
    .string()
    .min(1, "Start time is required"),
  endtime: z
    .string()
    .min(1, "End time is required"),
  timezone: z.string().min(1, "Timezone is required"),
  active: z.boolean(),
  days: z.array(z.string()).min(1, "At least one day must be selected"),
  accountId: z.string().min(1, "Account is required"),
  resources: z.array(z.object({
    id: z.string(),
    type: z.enum(['ec2', 'ecs', 'rds', 'asg', 'docdb']),
    name: z.string(),
    arn: z.string().optional()
  })).optional(),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

const DAYS_OF_WEEK = [
  { id: "Mon", label: "Monday" },
  { id: "Tue", label: "Tuesday" },
  { id: "Wed", label: "Wednesday" },
  { id: "Thu", label: "Thursday" },
  { id: "Fri", label: "Friday" },
  { id: "Sat", label: "Saturday" },
  { id: "Sun", label: "Sunday" },
];

const TIMEZONES = [
  { value: "Asia/Kolkata", label: "Asia/Kolkata (IST)" },
  { value: "America/New_York", label: "America/New_York (EST)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (PST)" },
  { value: "Europe/London", label: "Europe/London (GMT)" },
  { value: "UTC", label: "UTC" },
];

interface ScheduleFormProps {
  initialData?: UISchedule;
  isEditing?: boolean;
}

export function ScheduleForm({ initialData, isEditing = false }: ScheduleFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<{
    ec2: Array<{ id: string, name: string, type: 'ec2', arn: string }>;
    ecs: Array<{ id: string, name: string, type: 'ecs', arn: string }>;
    rds: Array<{ id: string, name: string, type: 'rds', arn: string }>;
    asg: Array<{ id: string, name: string, type: 'asg', arn: string }>;
    docdb: Array<{ id: string, name: string, type: 'docdb', arn: string }>;
  }>({ ec2: [], ecs: [], rds: [], asg: [], docdb: [] });
  const [hasScanned, setHasScanned] = useState(false);
  const [openAccountCombobox, setOpenAccountCombobox] = useState(false);

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      name: initialData?.name || "",
      starttime: initialData?.starttime || "09:00:00",
      endtime: initialData?.endtime || "18:00:00",
      timezone: initialData?.timezone || "Asia/Kolkata",
      active: initialData?.active ?? true,
      days: initialData?.days || [],
      accountId: initialData?.accounts?.[0] || "",
      resources: initialData?.resources || [],
    },
  });

  const selectedAccountId = form.watch("accountId");
  const selectedResources = form.watch("resources") || [];

  useEffect(() => {
    // Fetch accounts on mount
    const fetchAccounts = async () => {
      try {
        const result = await ClientAccountService.getAccounts({ statusFilter: 'active', connectionFilter: 'connected', limit: 1000 });
        setAccounts(result.accounts);
      } catch (error) {
        console.error("Failed to fetch accounts:", error);
      }
    };
    fetchAccounts();
  }, []);

  // When editing, if we have an account ID and resources but no scan results yet, trigger a silent scan to populate the grid options
  useEffect(() => {
    if (isEditing && initialData?.accounts?.[0] && !hasScanned && accounts.length > 0) {
        // Only auto-scan if we found the account in the list (loaded)
        handleScan(true); 
    }
  }, [isEditing, initialData, accounts, hasScanned]);

  // Reset scan results when account changes (only if user manually changes it)
  // Logic: if editing and matches initial, don't reset. If fresh create, reset.
  useEffect(() => {
      if (!isEditing && hasScanned) {
          setScanResults({ ec2: [], ecs: [], rds: [], asg: [], docdb: [] });
          setHasScanned(false);
          form.setValue("resources", []);
      } else if (isEditing && selectedAccountId !== initialData?.accounts?.[0]) {
           // User changed account in edit mode
           setScanResults({ ec2: [], ecs: [], rds: [], asg: [], docdb: [] });
           setHasScanned(false);
           form.setValue("resources", []);
      }
  }, [selectedAccountId, isEditing]);


  const handleScan = async (silent = false) => {
    const accId = form.getValues("accountId");
    if (!accId) return;
    
    if (!silent) setIsScanning(true);
    
    try {
      const resources = await ClientAccountService.scanResources(accId);
      
      const newResults = {
        ec2: resources.filter(r => r.type === 'ec2') as any[],
        ecs: resources.filter(r => r.type === 'ecs') as any[],
        rds: resources.filter(r => r.type === 'rds') as any[],
        asg: resources.filter(r => r.type === 'asg') as any[],
        docdb: resources.filter(r => r.type === 'docdb') as any[],
      };
      
      setScanResults(newResults);
      setHasScanned(true);

    } catch (error) {
      console.error("Scan failed:", error);
      // TODO: Toast
    } finally {
      if (!silent) setIsScanning(false);
    }
  };

  const onSubmit = async (data: ScheduleFormValues) => {
    try {
      setLoading(true);

      const payload: any = {
        name: data.name,
        type: "schedule",
        starttime: data.starttime,
        endtime: data.endtime,
        timezone: data.timezone,
        active: data.active,
        days: data.days,
        accountId: data.accountId,
        resources: data.resources,
      };

      if (isEditing) {
         await ClientScheduleService.updateSchedule(data.name, payload);
      } else {
         await ClientScheduleService.createSchedule(payload);
      }

      // Redirect to schedules list
      router.push("/schedules");
    } catch (error) {
      console.error("Failed to save schedule:", error);
      // TODO: Show error toast
    } finally {
      setLoading(false);
    }
  };

  const toggleResource = (resource: { id: string, type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb', name: string, arn: string }, checked: boolean) => {
    const currentResources = form.getValues("resources") || [];
    if (checked) {
      // Avoid duplicates
      if (!currentResources.some(r => r.id === resource.id)) {
          form.setValue("resources", [...currentResources, resource]);
      }
    } else {
      form.setValue("resources", currentResources.filter(r => r.id !== resource.id));
    }
  };

  const toggleAll = (type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb', checked: boolean) => {
      const typeResources = scanResults[type];
      const currentResources = form.getValues("resources") || [];
      const otherResources = currentResources.filter(r => r.type !== type);

      if (checked) {
          // Add all of this type
           form.setValue("resources", [...otherResources, ...typeResources]);
      } else {
          // Remove all of this type
          form.setValue("resources", otherResources);
      }
  };
  
  const isAllSelected = (type: 'ec2' | 'ecs' | 'rds' | 'asg' | 'docdb') => {
      const typeResources = scanResults[type];
      if (typeResources.length === 0) return false;
      return typeResources.every(r => selectedResources.some(sr => sr.id === r.id));
  };


  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        
        {/* Target Account */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Server className="h-5 w-5" />
              <span>Target Account</span>
            </CardTitle>
            <CardDescription>
              Select the AWS account and resources to apply this schedule to
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="accountId"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>AWS Account</FormLabel>
                   {/* Searchable Dropdown (Combobox) */}
                   <Popover open={openAccountCombobox} onOpenChange={setOpenAccountCombobox}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={openAccountCombobox}
                          className={cn(
                            "w-full justify-between",
                            !field.value && "text-muted-foreground"
                          )}
                          disabled={isEditing}
                        >
                          {field.value
                            ? accounts.find((account) => account.accountId === field.value)?.name + ` (${field.value})`
                            : "Select an account"}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0">
                      <Command>
                        <CommandInput placeholder="Search account..." />
                        <CommandList>
                          <CommandEmpty>No account found.</CommandEmpty>
                          <CommandGroup>
                            {accounts.map((account) => (
                              <CommandItem
                                value={`${account.name} ${account.accountId}`}
                                key={account.accountId}
                                onSelect={() => {
                                  form.setValue("accountId", account.accountId);
                                  setOpenAccountCombobox(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    account.accountId === field.value
                                      ? "opacity-100"
                                      : "opacity-0"
                                  )}
                                />
                                {account.name} ({account.accountId})
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>

                  <FormDescription>
                    {isEditing ? "Account cannot be changed for existing schedules" : "Only connected accounts are shown"}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {(selectedAccountId || isEditing) && (
              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Resources</h3>
                  <Button 
                    type="button" 
                    variant="secondary" 
                    size="sm"
                    onClick={() => handleScan()}
                    disabled={isScanning}
                  >
                    {isScanning ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Scanning...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Scan Resources
                      </>
                    )}
                  </Button>
                </div>

                {hasScanned && (
                  <Tabs defaultValue="ec2" className="w-full">
                    <TabsList className="grid w-full grid-cols-5">
                      <TabsTrigger value="ec2">EC2 ({scanResults.ec2.length})</TabsTrigger>
                      <TabsTrigger value="ecs">ECS ({scanResults.ecs.length})</TabsTrigger>
                      <TabsTrigger value="rds">RDS ({scanResults.rds.length})</TabsTrigger>
                      <TabsTrigger value="asg">ASG ({scanResults.asg.length})</TabsTrigger>
                      <TabsTrigger value="docdb">DocDB ({scanResults.docdb.length})</TabsTrigger>
                    </TabsList>
                    
                    {['ec2', 'ecs', 'rds', 'asg', 'docdb'].map((type) => (
                        <TabsContent key={type} value={type}>
                             <div className="flex items-center space-x-2 pb-2 pl-4">
                                 <Checkbox 
                                    id={`select-all-${type}`}
                                    checked={isAllSelected(type as any)}
                                    onCheckedChange={(c) => toggleAll(type as any, c as boolean)}
                                 />
                                 <label htmlFor={`select-all-${type}`} className="text-sm font-medium cursor-pointer">
                                     Select All
                                 </label>
                             </div>
                             <ScrollArea className="h-[300px] w-full rounded-md border p-4">
                                {scanResults[type as keyof typeof scanResults].length === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-4">No {type.toUpperCase()} resources found.</p>
                                ) : (
                                    <div className="space-y-3">
                                        {scanResults[type as keyof typeof scanResults].map((res) => (
                                        <div key={res.id} className="flex items-start space-x-3 p-2 hover:bg-muted/50 rounded-md">
                                            <Checkbox 
                                                id={res.id}
                                                checked={selectedResources.some(r => r.id === res.id)}
                                                onCheckedChange={(c) => toggleResource(res, c as boolean)}
                                                className="mt-1"
                                            />
                                            <div className="grid gap-1.5 leading-none">
                                                <label
                                                    htmlFor={res.id}
                                                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                                                >
                                                    {res.name}
                                                </label>
                                                <p className="text-xs text-muted-foreground break-all">
                                                    {res.arn || res.id}
                                                </p>
                                            </div>
                                        </div>
                                        ))}
                                    </div>
                                )}
                            </ScrollArea>
                        </TabsContent>
                    ))}
                  </Tabs>
                )}
                 <div className="text-sm text-muted-foreground">
                    Selected: {selectedResources.length} resources
                 </div>
              </div>
            )}
           </CardContent>
        </Card>

        {/* Basic Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Calendar className="h-5 w-5" />
              <span>Basic Information</span>
            </CardTitle>
            <CardDescription>
              Configure the basic schedule details
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schedule Name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="office-hours-9am-6pm-weekdays"
                      disabled={isEditing}
                    />
                  </FormControl>
                  <FormDescription>
                    {isEditing ? "Schedule Name cannot be changed" : "A unique identifier for this schedule (lowercase, hyphens allowed)"}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active Schedule</FormLabel>
                    <FormDescription>
                      Whether this schedule is currently active and will be used
                      for resource management
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Time Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Clock className="h-5 w-5" />
              <span>Time Configuration</span>
            </CardTitle>
            <CardDescription>
              Set the operating hours for this schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="starttime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Time</FormLabel>
                    <FormControl>
                      <Input 
                        type="time" 
                        {...field} 
                        value={field.value?.substring(0, 5) || ''}
                        onChange={(e) => field.onChange(e.target.value + ':00')}
                      />
                    </FormControl>
                    <FormDescription>
                      When resources should be started
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="endtime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Time</FormLabel>
                    <FormControl>
                      <Input 
                        type="time" 
                        {...field} 
                        value={field.value?.substring(0, 5) || ''}
                        onChange={(e) => field.onChange(e.target.value + ':00')}
                      />
                    </FormControl>
                    <FormDescription>
                      When resources should be stopped
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timezone</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a timezone" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    The timezone for start and end times
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
        
        {/* Days of Week */}
        <Card>
          <CardHeader>
            <CardTitle>Days of Week</CardTitle>
            <CardDescription>
              Select which days this schedule should be active
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="days"
              render={() => (
                <FormItem>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {DAYS_OF_WEEK.map((day) => (
                      <FormField
                        key={day.id}
                        control={form.control}
                        name="days"
                        render={({ field }) => {
                          return (
                            <FormItem
                              key={day.id}
                              className="flex flex-row items-start space-x-3 space-y-0"
                            >
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(day.id)}
                                  onCheckedChange={(checked) => {
                                    return checked
                                      ? field.onChange([...field.value, day.id])
                                      : field.onChange(
                                        field.value?.filter(
                                          (value) => value !== day.id
                                        )
                                      );
                                  }}
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal">
                                {day.label}
                              </FormLabel>
                            </FormItem>
                          );
                        }}
                      />
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Preview */}
        <Card>
          <CardHeader>
            <CardTitle>Schedule Preview</CardTitle>
            <CardDescription>
              Review your schedule configuration
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Badge variant={form.watch("active") ? "default" : "secondary"}>
                  {form.watch("active") ? "Active" : "Inactive"}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {form.watch("name")}
                </span>
              </div>

              <div className="flex items-center space-x-4 text-sm">
                <div className="flex items-center space-x-2">
                  <Clock className="h-4 w-4" />
                  <span>
                    {form.watch("starttime")} - {form.watch("endtime")}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    {form.watch("timezone")}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {form.watch("days")?.map((day) => (
                  <Badge key={day} variant="outline">
                    {DAYS_OF_WEEK.find((d) => d.id === day)?.label}
                  </Badge>
                ))}
              </div>
              
              <div className="text-sm text-muted-foreground pt-2">
                 Resources Targeted: {selectedResources.length} resources
              </div>
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
            {isEditing ? "Update Schedule" : "Create Schedule"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
