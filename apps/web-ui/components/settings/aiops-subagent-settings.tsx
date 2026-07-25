'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Bot, Gauge, Save } from 'lucide-react';

import {
  useAiopsSubagentSettings,
  useSaveAiopsSubagentSettings,
  type SubagentBudget,
} from '@/lib/queries/aiops-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

const schema = z.object({
  enabled: z.boolean(),
  maxConcurrentSubagents: z.number().int(),
  maxSubagentsPerRun: z.number().int(),
  maxSubagentTokensPerRun: z.number().int(),
  subagentMaxIterations: z.number().int(),
  subagentTimeoutMs: z.number().int(),
});

type FormValues = z.infer<typeof schema>;

const FIELDS: Array<{
  name: keyof Omit<SubagentBudget, 'enabled'>;
  label: string;
  help: string;
}> = [
  {
    name: 'maxConcurrentSubagents',
    label: 'Concurrent sub-agents',
    help: 'How many sub-agents may run at the same time. Higher finishes fan-out work faster but increases the chance of provider throttling.',
  },
  {
    name: 'maxSubagentsPerRun',
    label: 'Sub-agents per run',
    help: 'Total sub-agents a single chat run may dispatch before it falls back to working serially.',
  },
  {
    name: 'maxSubagentTokensPerRun',
    label: 'Token budget per run',
    help: 'Combined sub-agent token spend allowed in one run. When exhausted, the agent completes the work itself instead of failing.',
  },
  {
    name: 'subagentMaxIterations',
    label: 'Iterations per sub-agent',
    help: 'Reasoning/tool laps a single sub-agent may take before it must report what it has found.',
  },
  {
    name: 'subagentTimeoutMs',
    label: 'Sub-agent timeout (ms)',
    help: 'Wall-clock limit for one sub-agent. On timeout it returns partial findings rather than failing the run.',
  },
];

export function AiopsSubagentSettings() {
  const { data, isLoading, error } = useAiopsSubagentSettings();
  const saveMutation = useSaveAiopsSubagentSettings();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: false,
      maxConcurrentSubagents: 3,
      maxSubagentsPerRun: 8,
      maxSubagentTokensPerRun: 400000,
      subagentMaxIterations: 8,
      subagentTimeoutMs: 180000,
    },
  });

  useEffect(() => {
    if (data?.budget) form.reset(data.budget);
  }, [data, form]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const platformEnabled = data?.platformEnabled ?? false;
  const bounds = data?.bounds;

  // Zod rejects a blank number input as NaN before onSubmit ever runs. Without an
  // invalid handler the click is a silent no-op with zero feedback, so surface it.
  const onInvalid = () => {
    toast.error('Some values are invalid — check the highlighted fields.');
  };

  const onSubmit = async (values: FormValues) => {
    // Bounds are enforced server-side too; this only produces a friendlier message.
    for (const field of FIELDS) {
      const bound = bounds?.[field.name];
      const value = values[field.name];
      if (bound && (value < bound.min || value > bound.max)) {
        toast.error(`${field.label} must be between ${bound.min} and ${bound.max}`);
        return;
      }
    }
    try {
      await saveMutation.mutateAsync(values);
      toast.success('Sub-agent settings saved — new runs will use this configuration');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save sub-agent settings');
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="flex-1 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sub-Agents</h1>
        <p className="text-muted-foreground mt-1">
          Sub-agents let one AI Ops run investigate several accounts or regions at the same time.
          They are read-only: anything that changes infrastructure still runs on the main agent
          under your normal approval flow.
        </p>
      </div>

      {!platformEnabled && (
        <Alert>
          <AlertDescription>
            Sub-agents are disabled for this deployment, so these settings are read-only. An
            administrator must enable the feature before they can be changed.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Enable sub-agents
          </CardTitle>
          <CardDescription>
            When off, every run executes serially exactly as before.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="enabled"
              checked={form.watch('enabled')}
              onCheckedChange={(checked) => form.setValue('enabled', checked, { shouldDirty: true })}
              disabled={!platformEnabled}
            />
            <Label htmlFor="enabled">Dispatch sub-agents for parallel investigation</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            Budget limits
          </CardTitle>
          <CardDescription>
            These bound how much work and spend one run may fan out. Exceeding a limit never fails
            the run — the agent finishes the work serially instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {FIELDS.map((field) => {
            const bound = bounds?.[field.name];
            return (
              <div key={field.name} className="space-y-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                <Input
                  id={field.name}
                  type="number"
                  className="w-48"
                  min={bound?.min}
                  max={bound?.max}
                  disabled={!platformEnabled}
                  {...form.register(field.name, { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
                {bound && (
                  <p className="text-xs text-muted-foreground">
                    Allowed: {bound.min}–{bound.max}. Default {bound.default}.
                  </p>
                )}
                {form.formState.errors[field.name] && (
                  <p className="text-xs text-destructive">
                    Enter a whole number between {bound?.min} and {bound?.max}.
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Button type="submit" disabled={saveMutation.isPending || !platformEnabled}>
        {saveMutation.isPending ? (
          <Spinner className="h-4 w-4 mr-2" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        Save settings
      </Button>
    </form>
  );
}
