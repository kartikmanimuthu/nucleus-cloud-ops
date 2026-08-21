'use client';

/**
 * AI Ops feature settings card — the tenant-facing switchboard for behaviors
 * that used to be env-var kill-switches (chat triage, the memory subsystems,
 * autonomous skill creation, the run iteration cap). Entirely UI-driven; the
 * server clamps numeric values against FEATURE_BOUNDS on read and write.
 *
 * Rendered next to AiopsSubagentSettings in the AI Ops console settings dialog
 * and on the /app/agent-ops/settings/subagents page.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GatedButton } from '@/components/rbac/gated';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  useAiopsSubagentSettings,
  useSaveAiopsFeatureSettings,
  type AiopsFeatureConfig,
} from '@/lib/queries/aiops-settings';

const TOGGLES: Array<{ key: keyof AiopsFeatureConfig; label: string; help: string }> = [
  {
    key: 'chatTriageEnabled',
    label: 'Smart routing (chat triage)',
    help: 'One quick classifier call answers greetings/small talk directly and routes real work to the full agent — it also auto-picks the matching skill. Off: every message runs the whole planning graph.',
  },
  {
    key: 'workingMemoryEnabled',
    label: 'Working memory',
    help: 'Compacts long runs in-session (summary folding) so the agent keeps its train of thought within the context budget.',
  },
  {
    key: 'episodicMemoryEnabled',
    label: 'Episodic memory',
    help: 'Distills one episode (context → actions → outcome) per tool-using run and replays similar past sessions as experience.',
  },
  {
    key: 'proceduralMemoryEnabled',
    label: 'Procedural memory',
    help: 'Learns operating rules from corrections and failures, injected as "Operating rules (learned)" on later runs.',
  },
  {
    key: 'memoryReconcileEnabled',
    label: 'Memory reconciliation',
    help: 'An LLM judge merges new facts into existing memories (update/supersede) instead of piling up near-duplicates.',
  },
  {
    key: 'autoSkillCreationEnabled',
    label: 'Autonomous skill creation',
    help: 'When a domain accumulates enough matured rules, the system authors a read-only sys- skill from them. Disabling a created skill vetoes it.',
  },
];

const NUMBERS: Array<{ key: 'autoSkillMaturityThreshold' | 'skillSynthesisMinRules' | 'maxIterations'; label: string; help: string }> = [
  {
    key: 'maxIterations',
    label: 'Max iterations per run',
    help: 'Executor loop cap for a single run (planning and fast agents). Higher = more thorough and more expensive.',
  },
  {
    key: 'autoSkillMaturityThreshold',
    label: 'Rule maturity threshold',
    help: 'Times a learned rule must be recalled before it counts as matured.',
  },
  {
    key: 'skillSynthesisMinRules',
    label: 'Matured rules per auto-skill',
    help: 'Matured rules a domain needs before an autonomous skill is synthesized.',
  },
];

export function AiopsFeatureSettings() {
  const { data, isLoading } = useAiopsSubagentSettings();
  const saveMutation = useSaveAiopsFeatureSettings();
  const [draft, setDraft] = useState<AiopsFeatureConfig | null>(null);

  // Initialize the draft once from the server value; later refetches must not
  // clobber unsaved edits.
  useEffect(() => {
    if (data?.features && !draft) setDraft(data.features);
  }, [data, draft]);

  if (isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner size="sm" label="Loading AI Ops settings" /> Loading…
      </div>
    );
  }

  const bounds = data?.featureBounds;

  const save = () => {
    saveMutation.mutate(draft, {
      onSuccess: (saved) => {
        setDraft(saved);
        toast.success('AI Ops settings saved', {
          description: 'Applied to new runs immediately on this instance; within ~30s everywhere.',
        });
      },
      onError: (err) => toast.error('Could not save AI Ops settings', { description: err.message }),
    });
  };

  return (
    <Card data-testid="aiops-feature-settings">
      <CardHeader>
        <CardTitle>Agent behavior</CardTitle>
        <CardDescription>
          Routing, memory, and skill-learning features for this organization. All settings live
          here — no server configuration involved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {TOGGLES.map(({ key, label, help }) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor={`feat-${key}`}>{label}</Label>
              <p className="text-xs text-muted-foreground">{help}</p>
            </div>
            <Switch
              id={`feat-${key}`}
              checked={draft[key] as boolean}
              onCheckedChange={(checked) => setDraft({ ...draft, [key]: checked })}
            />
          </div>
        ))}

        <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
          {NUMBERS.map(({ key, label, help }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`feat-${key}`}>{label}</Label>
              <Input
                id={`feat-${key}`}
                type="number"
                min={bounds?.[key]?.min}
                max={bounds?.[key]?.max}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">
                {help}
                {bounds?.[key] ? ` (${bounds[key].min}–${bounds[key].max})` : ''}
              </p>
            </div>
          ))}
        </div>

        {/*
          * Gated on what PUT /api/settings/aiops enforces — authorize('update',
          * 'Agent') at route.ts:64. Subject 'Agent' is the "AI Agent" submodule
          * under AI Ops. The sub-agent card below shares this same route, so both
          * save buttons carry the same gate.
          */}
        <GatedButton action="update" subject="Agent" type="button" onClick={save} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <Spinner size="sm" label="Saving" /> : 'Save behavior settings'}
        </GatedButton>
      </CardContent>
    </Card>
  );
}
