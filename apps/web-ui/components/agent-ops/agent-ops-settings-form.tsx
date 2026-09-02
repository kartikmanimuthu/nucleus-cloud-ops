'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Cpu, Gauge, Layers, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAgentOpsDefaults, useSaveAgentOpsDefaults } from '@/lib/queries/agent-ops-settings';
import { useProviderModels, defaultModelId } from '@/lib/queries/providers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type { AgentMode } from '@/lib/agent-ops/types';
import { SELECTABLE_MODES } from '@/lib/agent-ops/types';

// Keep in sync with lib/agent-ops/agent-ops-defaults.ts.
const MIN_MAX_ITERATIONS = 10;
const MAX_MAX_ITERATIONS = 500;

// Labels for the modes offered by SELECTABLE_MODES (the single source of
// truth for what's selectable, defined in lib/agent-ops/types.ts — 'fast' is
// legacy-only and never appears there).
const MODE_LABELS: Partial<Record<AgentMode, string>> = {
    plan: 'Plan & execute — evaluator picks a skill, then plans and reflects',
    deep: 'Deep — sub-agents, to-do list, and a virtual filesystem',
};

interface AgentOpsSettingsFormProps {
    backHref?: string;
    backLabel?: string;
}

export function AgentOpsSettingsForm({
    backHref = '/app/agent-ops',
    backLabel = 'Back to Agent Ops',
}: AgentOpsSettingsFormProps) {
    const router = useRouter();
    const { data, isLoading } = useAgentOpsDefaults();
    const { data: models, isLoading: modelsLoading } = useProviderModels();
    const saveMutation = useSaveAgentOpsDefaults();
    const saving = saveMutation.isPending;

    const [defaultModel, setDefaultModel] = useState('');
    const [maxIterations, setMaxIterations] = useState<number>(150);
    const [defaultMode, setDefaultMode] = useState<AgentMode>('plan');
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    // Hydrate the form once the stored config arrives. With nothing stored yet,
    // fall back to the LLM provider's default chat model rather than showing an
    // empty picker — the same model the executor would resolve at runtime.
    useEffect(() => {
        if (data) {
            setDefaultModel((prev) => prev || data.defaultModel || defaultModelId(models ?? []));
            setMaxIterations(data.maxIterations || 150);
            setDefaultMode(data.defaultMode || 'plan');
        }
    }, [data, models]);

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const configured = data?.configured ?? false;
    const noModels = !modelsLoading && (!models || models.length === 0);
    // A previously-saved model that is no longer offered by any provider — keep
    // it selectable so the admin sees what's stored and can consciously change it.
    const staleModel = defaultModel && models && !models.some(m => m.id === defaultModel);

    const handleSave = async () => {
        if (!defaultModel) {
            setError('Select a default model');
            return;
        }
        if (!Number.isInteger(maxIterations) || maxIterations < MIN_MAX_ITERATIONS || maxIterations > MAX_MAX_ITERATIONS) {
            setError(`Graph limit must be a whole number between ${MIN_MAX_ITERATIONS} and ${MAX_MAX_ITERATIONS}`);
            return;
        }
        setError('');
        try {
            await saveMutation.mutateAsync({ defaultModel, maxIterations, defaultMode });
            setSaved(true);
            toast.success('Agent Ops defaults saved — new runs will use this configuration');
            setTimeout(() => setSaved(false), 3000);
        } catch (err: any) {
            setError(err.message || 'Failed to save');
            toast.error(err.message || 'Failed to save Agent Ops defaults');
        }
    };

    return (
        <div className="flex-1 bg-background max-w-3xl mx-auto space-y-6">
            <div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
                    onClick={() => router.push(backHref)}
                >
                    <ArrowLeft className="h-4 w-4" />
                    {backLabel}
                </Button>
            </div>

            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Agent Ops Defaults</h1>
                    <p className="text-muted-foreground mt-1">
                        Default execution configuration applied to every new Agent Ops run for this organization.
                        A run that specifies its own model still overrides the default.
                    </p>
                </div>
                {configured && (
                    <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        Configured
                    </Badge>
                )}
            </div>

            {noModels && (
                <Alert>
                    <AlertDescription>
                        No models are available yet. Configure an LLM provider under{' '}
                        <button
                            className="text-blue-500 hover:underline"
                            onClick={() => router.push('/app/agent-ops/providers')}
                        >
                            Settings → Providers
                        </button>{' '}
                        first, then choose a default model here.
                    </AlertDescription>
                </Alert>
            )}

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Cpu className="h-4 w-4" />
                        Default Model
                    </CardTitle>
                    <CardDescription>
                        The LLM used for planning, execution, and reflection when a run does not select its own model.
                        Models come from your configured providers.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Label htmlFor="defaultModel">
                        Model <span className="text-destructive">*</span>
                    </Label>
                    <Select value={defaultModel} onValueChange={setDefaultModel} disabled={noModels}>
                        <SelectTrigger id="defaultModel">
                            <SelectValue placeholder={modelsLoading ? 'Loading models…' : 'Select a model'} />
                        </SelectTrigger>
                        <SelectContent>
                            {staleModel && (
                                <SelectItem value={defaultModel}>
                                    {defaultModel} (not currently available)
                                </SelectItem>
                            )}
                            {(models ?? []).map(m => (
                                <SelectItem key={m.id} value={m.id}>
                                    {m.label}
                                    <span className="text-muted-foreground"> · {m.provider}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {staleModel && (
                        <p className="text-xs text-amber-600 dark:text-amber-500">
                            The saved model is no longer offered by any provider. Pick a current model and save.
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Gauge className="h-4 w-4" />
                        Graph Iteration Limit
                    </CardTitle>
                    <CardDescription>
                        Maximum number of reasoning/tool iterations a single run may take before it is force-completed.
                        This caps both the executor loop and LangGraph&apos;s recursion limit. Higher values allow more
                        complex autonomous tasks but cost more tokens.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Label htmlFor="maxIterations">
                        Max iterations <span className="text-destructive">*</span>
                    </Label>
                    <Input
                        id="maxIterations"
                        type="number"
                        min={MIN_MAX_ITERATIONS}
                        max={MAX_MAX_ITERATIONS}
                        value={maxIterations}
                        onChange={e => setMaxIterations(Number(e.target.value))}
                        className="w-40"
                    />
                    <p className="text-xs text-muted-foreground">
                        Between {MIN_MAX_ITERATIONS} and {MAX_MAX_ITERATIONS}. Default is 150.
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Layers className="h-4 w-4" />
                        Default Execution Mode
                    </CardTitle>
                    <CardDescription>
                        Used when a run does not choose its own mode — chiefly channel triggers (Slack, Jira,
                        Discord, Telegram, webhook), which have no UI to pick one. The New Run dialog and
                        scheduled tasks always send their own explicit selection and ignore this default.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Label htmlFor="defaultMode">Execution mode</Label>
                    <Select value={defaultMode} onValueChange={v => setDefaultMode(v as AgentMode)}>
                        <SelectTrigger id="defaultMode" className="w-full sm:w-80">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SELECTABLE_MODES.map(m => (
                                <SelectItem key={m} value={m}>
                                    {MODE_LABELS[m] ?? m}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
            </Card>

            {error && (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            <Button
                onClick={handleSave}
                disabled={saving || noModels}
                className={saved ? 'bg-green-600 hover:bg-green-700' : ''}
            >
                {saving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : saved ? (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                ) : (
                    <Save className="h-4 w-4 mr-2" />
                )}
                {saved ? 'Saved' : 'Save Defaults'}
            </Button>
        </div>
    );
}
