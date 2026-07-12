# Convert Chat into Recurring Scheduled Task — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Convert to scheduled task" action in the AIOps chat that analyzes the whole conversation into a self-contained recurring run prompt + suggested cadence, then lands the user on the Scheduled Tasks screen with the create dialog pre-filled.

**Architecture:** Mirror the existing "Save chat as skill" flow. A new distill API route (`/api/agent-ops/scheduled-tasks/distill`) runs the tenant's default LLM over the transcript and returns `{ name, prompt, suggestedCron, cadenceLabel }`. The chat button stores that draft in `sessionStorage` and navigates to the Scheduled Tasks page with `?prefill=1`; the page reads + clears it and auto-opens `ScheduledTaskDialog` pre-filled. Saving uses the unchanged create path.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query v5, Vitest, LangChain model factory, sonner toasts.

## Global Constraints

- API responses: `NextResponse.json({ success: true, data })` / `{ success: false, error }`.
- Data access + model init reuse: `resolveDefaultModelConfig(tenantId)` + `createAgentModels(modelConfig).main`; tenant from `getSessionTenantId()` (never client-supplied).
- Transcript guard: `MAX_TRANSCRIPT_CHARS = 600_000` → 413; missing transcript → 400; non-JSON model output → 502; `isProviderConfigError` → 400.
- RBAC: `authorize('create', 'Agent')` (the `Agent` subject → `AIOps` module in `lib/rbac/types.ts`).
- Distilled task prompt must be CONCRETE and self-contained (retain real IDs/regions/resources/thresholds; no placeholders; never ask the user anything) — opposite of skill distillation.
- Safe defaults NOT inferred: `autoApprove=false`, `notification=none`, timezone = dialog default.
- Test runner: `cd apps/web-ui && bun run test` (Vitest, `vitest run`).
- Use `@/` path alias; components 2-space indent; named exports.

---

### Task 1: Distill API route + unit tests

**Files:**
- Create: `apps/web-ui/app/api/agent-ops/scheduled-tasks/distill/route.ts`
- Test: `apps/web-ui/app/api/agent-ops/scheduled-tasks/distill/route.test.ts`

**Interfaces:**
- Consumes: `authorize` (`@/lib/rbac/authorize`), `getSessionTenantId` (`@/lib/auth-session`), `resolveDefaultModelConfig` (`@/lib/agent/model-resolver`), `createAgentModels` (`@/lib/agent/model-factory`), `isProviderConfigError` (`@/lib/agent/provider-errors`).
- Produces: `POST` handler. Success body: `{ success: true, data: { name: string; prompt: string; suggestedCron: string; cadenceLabel: string } }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/app/api/agent-ops/scheduled-tasks/distill/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveDefaultModelConfig: vi.fn() }));
vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));
vi.mock('@/lib/agent/provider-errors', () => ({
    isProviderConfigError: vi.fn((err: unknown) => err instanceof ProviderConfigError),
    ProviderConfigError: class ProviderConfigError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'ProviderConfigError';
        }
    },
}));

import { POST } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';

const makeRequest = (body?: unknown) => ({ json: vi.fn().mockResolvedValue(body ?? {}) }) as any;

const validDraftJson = JSON.stringify({
    name: 'Daily Cost Anomaly Review',
    prompt: 'Every run, check account 111122223333 for cost anomalies. 1. Run `aws ce get-anomalies`. 2. Report anomalies over $50 in the run summary.',
    suggestedCron: '0 9 * * *',
    cadenceLabel: 'Daily at 9:00 AM',
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1');
    vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'anthropic', modelId: 'm1' } as any);
});

describe('POST /api/agent-ops/scheduled-tasks/distill', () => {
    it('403s when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });

    it('400s on missing transcript', async () => {
        const res = await POST(makeRequest({}));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('413s when transcript exceeds the size guard, without calling the model', async () => {
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'a'.repeat(600_001) }));
        expect((res as any)._status).toBe(413);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('sends the full transcript to the model with no truncation', async () => {
        const longTranscript = `USER: ${'b'.repeat(100_000)}`;
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        await POST(makeRequest({ transcript: longTranscript }));
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke.mock.calls[0][0] as string).toContain(longTranscript);
    });

    it('returns the parsed draft on success', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: check my costs' }));
        expect((res as any)._status).toBe(200);
        expect((res as any)._data).toEqual({
            success: true,
            data: {
                name: 'Daily Cost Anomaly Review',
                prompt: 'Every run, check account 111122223333 for cost anomalies. 1. Run `aws ce get-anomalies`. 2. Report anomalies over $50 in the run summary.',
                suggestedCron: '0 9 * * *',
                cadenceLabel: 'Daily at 9:00 AM',
            },
        });
    });

    it('502s when the model does not return valid JSON', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'not json' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(502);
    });

    it('falls back to a daily cron when suggestedCron is not a 5-field string', async () => {
        const invoke = vi.fn().mockResolvedValue({
            content: JSON.stringify({ name: 'X', prompt: 'p', suggestedCron: 'nonsense', cadenceLabel: 'l' }),
        });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._data.data.suggestedCron).toBe('0 9 * * *');
    });

    it('400s with the provider message when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No LLM provider is configured.'));
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.error).toBe('No LLM provider is configured.');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bun run test -- distill/route.test.ts`
Expected: FAIL — `Cannot find module './route'` (route not created yet). (Both `skills/distill` and this file match; that's fine — ours fails to import.)

- [ ] **Step 3: Write the route implementation**

Create `apps/web-ui/app/api/agent-ops/scheduled-tasks/distill/route.ts`:

```typescript
/**
 * POST /api/agent-ops/scheduled-tasks/distill — analyze a chat transcript into a
 * self-contained recurring scheduled-task draft (no persistence). Unlike skill
 * distillation, this KEEPS concrete identifiers: the resulting prompt runs
 * unattended on a schedule, with no human to answer clarifying questions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

/** Same conservative provider-agnostic backstop used by /api/skills/distill. */
const MAX_TRANSCRIPT_CHARS = 600_000;

/** Fallback cadence when the chat gives no schedule signal. */
const DEFAULT_CRON = '0 9 * * *';

/** A valid 5-field cron expression (minute hour day-of-month month day-of-week). */
function isFiveFieldCron(value: unknown): value is string {
    return typeof value === 'string' && value.trim().split(/\s+/).length === 5;
}

const DISTILL_PROMPT = `You are converting an AI agent's chat transcript into a RECURRING SCHEDULED TASK
— a single, self-contained instruction the same agent will run on a schedule,
UNATTENDED, with NO human available to answer questions.

The transcript may include TOOL_CALL / TOOL_RESULT blocks showing the exact tools,
commands, or API calls the agent used (AWS CLI/SDK, Slack/Jira/other MCP tools,
file operations, knowledge-base lookups, etc.). This platform is not limited to
any one domain — infer the actual domain and tools from the transcript itself; do
not assume AWS or any other specific system.

CRITICAL — this is the OPPOSITE of writing a reusable template:
- KEEP every concrete target from the transcript verbatim: real account IDs,
  regions, resource names/ARNs, numeric thresholds, channel names, ticket
  projects. Do NOT replace them with placeholders — this is one specific job.
- The prompt must be fully standalone: assume fresh context on every run. Never
  refer to "the previous chat", "as we discussed", or the user. Never ask a
  clarifying question — decide and act.

Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name for the recurring job (max 6 words).
- "prompt": the standalone run instruction. It MUST:
  1. Open with the recurring objective in one line ("Every run, ...").
  2. Give the exact ordered steps, naming the REAL tools/commands/API calls used
     in the transcript (grounded in the actual TOOL_CALL blocks), with the
     concrete targets retained.
  3. End with the deliverable: what to check/compute and exactly what to include
     in the run summary each time.
- "suggestedCron": a 5-field cron expression inferred from the chat's intent
  (e.g. a daily audit -> "0 9 * * *"). If the chat gives no cadence signal, use
  "${DEFAULT_CRON}".
- "cadenceLabel": a short human label for that cadence (e.g. "Daily at 9:00 AM").

Transcript:
`;

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Agent');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { transcript } = body;
        if (!transcript || typeof transcript !== 'string') {
            return NextResponse.json(
                { success: false, error: 'Missing transcript' },
                { status: 400 }
            );
        }
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
            return NextResponse.json(
                {
                    success: false,
                    error: `This conversation is too long to convert in a single pass (~${Math.round(transcript.length / 1000)}k chars, limit ~${Math.round(MAX_TRANSCRIPT_CHARS / 1000)}k). Try a shorter portion of the chat, or configure a larger-context model as your tenant default.`,
                },
                { status: 413 }
            );
        }
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript}`);
        const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let draft: { name?: string; prompt?: string; suggestedCron?: string; cadenceLabel?: string };
        try {
            draft = JSON.parse(jsonText);
        } catch {
            return NextResponse.json(
                { success: false, error: 'Model did not return valid JSON' },
                { status: 502 }
            );
        }
        const suggestedCron = isFiveFieldCron(draft.suggestedCron) ? draft.suggestedCron.trim() : DEFAULT_CRON;
        return NextResponse.json({
            success: true,
            data: {
                name: draft.name ?? 'Untitled Scheduled Task',
                prompt: draft.prompt ?? '',
                suggestedCron,
                cadenceLabel: draft.cadenceLabel ?? 'Daily at 9:00 AM',
            },
        });
    } catch (error) {
        if (isProviderConfigError(error)) {
            return NextResponse.json(
                { success: false, error: (error as Error).message },
                { status: 400 }
            );
        }
        console.error('[ScheduledTasksAPI] distill error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to convert' },
            { status: 500 }
        );
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bun run test -- distill/route.test.ts`
Expected: PASS (all cases in this new file green; the existing `skills/distill` file also runs and stays green).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/app/api/agent-ops/scheduled-tasks/distill/
git commit -m "feat(agent-ops): distill chat transcript into a scheduled-task draft"
```

---

### Task 2: Dialog `prefill` prop + controlled open + shared handoff constants

**Files:**
- Modify: `apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx`

**Interfaces:**
- Produces (exported from the dialog module, imported by Tasks 3 & 4):
  - `export const SCHEDULED_TASK_PREFILL_KEY = 'agent-ops:scheduled-task-prefill'`
  - `export interface ScheduledTaskPrefill { name?: string; description?: string; cronExpression?: string }`
  - `ScheduledTaskDialog` gains optional props: `prefill?: ScheduledTaskPrefill`, `open?: boolean`, `onOpenChange?: (open: boolean) => void`.
- Consumes: existing `DEFAULT_FORM`, `useState`.

- [ ] **Step 1: Export the handoff constant + type and extend props**

In `apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx`, add after the imports (above `interface ScheduledTaskDialogProps`):

```tsx
/** sessionStorage key for a chat->scheduled-task draft handed to the tasks page. */
export const SCHEDULED_TASK_PREFILL_KEY = "agent-ops:scheduled-task-prefill"

/** Draft values seeded into the create dialog when arriving from "Convert chat". */
export interface ScheduledTaskPrefill {
    name?: string
    description?: string
    cronExpression?: string
}
```

Replace the `ScheduledTaskDialogProps` interface with:

```tsx
interface ScheduledTaskDialogProps {
    tenantId?: string
    task?: ScheduledTask         // if provided → edit mode
    prefill?: ScheduledTaskPrefill  // create-mode seed values (from "Convert chat")
    onSaved?: (task: ScheduledTask) => void
    trigger?: React.ReactNode
    open?: boolean               // controlled open (page-driven prefill)
    onOpenChange?: (open: boolean) => void
}
```

- [ ] **Step 2: Wire controlled open + prefill seeding**

Replace the component signature + `const [open, setOpen] = useState(false)` line:

```tsx
export function ScheduledTaskDialog({ tenantId = "default", task, prefill, onSaved, trigger, open: openProp, onOpenChange }: ScheduledTaskDialogProps) {
    const [openState, setOpenState] = useState(false)
    const open = openProp ?? openState
    const setOpen = (v: boolean) => { onOpenChange ? onOpenChange(v) : setOpenState(v) }
```

Then update the `useState` form initializer's `else` branch to fold in `prefill` (change the final `: DEFAULT_FORM` to merge prefilled create-mode values):

```tsx
    } : { ...DEFAULT_FORM, ...(prefill?.name ? { name: prefill.name } : {}), ...(prefill?.description ? { description: prefill.description } : {}), ...(prefill?.cronExpression ? { cronExpression: prefill.cronExpression } : {}) })
```

- [ ] **Step 3: Make the trigger optional when controlled**

In the returned JSX, replace the `<DialogTrigger asChild>...</DialogTrigger>` block so no trigger renders when the dialog is page-controlled with no explicit trigger:

```tsx
            {(trigger || openProp === undefined) && (
                <DialogTrigger asChild>
                    {trigger ?? (
                        <Button className="gap-2">
                            <CalendarClock className="h-4 w-4" />
                            New Scheduled Task
                        </Button>
                    )}
                </DialogTrigger>
            )}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep scheduled-task-dialog || echo "no new dialog errors"`
Expected: `no new dialog errors` (existing uncontrolled call sites on the page still compile — `open`/`onOpenChange`/`prefill` are all optional).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx
git commit -m "feat(agent-ops): scheduled-task dialog supports prefill + controlled open"
```

---

### Task 3: Distill query hook + chat "Convert to scheduled task" button (producer)

**Files:**
- Modify: `apps/web-ui/lib/queries/agent-ops-scheduled-tasks.ts`
- Modify: `apps/web-ui/components/agent/chat-interface.tsx`

**Interfaces:**
- Consumes: `SCHEDULED_TASK_PREFILL_KEY` (from Task 2), `buildChatTranscript` (`@/lib/agent/build-chat-transcript`, already imported in chat-interface), `useRouter` (`next/navigation`).
- Produces: `useDistillScheduledTask()` → mutation returning `{ name: string; prompt: string; suggestedCron: string; cadenceLabel: string }`.

- [ ] **Step 1: Add the distill hook**

Append to `apps/web-ui/lib/queries/agent-ops-scheduled-tasks.ts`:

```typescript
export interface ScheduledTaskDraft {
    name: string;
    prompt: string;
    suggestedCron: string;
    cadenceLabel: string;
}

export function useDistillScheduledTask() {
    return useMutation({
        mutationFn: async (transcript: string): Promise<ScheduledTaskDraft> => {
            const res = await fetch('/api/agent-ops/scheduled-tasks/distill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcript }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
            return data.data as ScheduledTaskDraft;
        },
    });
}
```

- [ ] **Step 2: Import router, icon, and the hook in chat-interface**

In `apps/web-ui/components/agent/chat-interface.tsx`:

Add `CalendarPlus` to the lucide-react import block (alongside `Sparkles`):

```tsx
  Sparkles,
  CalendarPlus,
```

Add near the other `next` imports (top of file — add a new line):

```tsx
import { useRouter } from "next/navigation";
```

Add to the query-hook imports (next to `useDistillSkill`):

```tsx
import { useDistillScheduledTask } from "@/lib/queries/agent-ops-scheduled-tasks";
import { SCHEDULED_TASK_PREFILL_KEY } from "@/components/agent-ops/scheduled-task-dialog";
```

- [ ] **Step 3: Add the router + hook instance and the handler**

Inside the component, next to `const distillSkill = useDistillSkill();` add:

```tsx
  const router = useRouter();
  const distillScheduledTask = useDistillScheduledTask();
```

Immediately after the `handleSaveAsSkill` function definition, add:

```tsx
  const handleConvertToScheduledTask = async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillScheduledTask.mutateAsync(transcript);
      sessionStorage.setItem(
        SCHEDULED_TASK_PREFILL_KEY,
        JSON.stringify({ name: draft.name, description: draft.prompt, cronExpression: draft.suggestedCron })
      );
      router.push("/app/agent-ops/scheduled-tasks?prefill=1");
    } catch (e) {
      toast.error("Could not convert chat to a scheduled task", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
```

- [ ] **Step 4: Add the header button**

In `apps/web-ui/components/agent/chat-interface.tsx`, immediately after the `{/* Save as skill */}` `<Button>...</Button>` block (the one calling `handleSaveAsSkill`), insert:

```tsx
              {/* Convert to scheduled task */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={handleConvertToScheduledTask}
                title="Convert chat into a recurring scheduled task"
                aria-label="Convert to scheduled task"
                disabled={messages.length === 0 || distillScheduledTask.isPending}
              >
                <CalendarPlus className="w-3.5 h-3.5" />
              </Button>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "chat-interface|agent-ops-scheduled-tasks" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/queries/agent-ops-scheduled-tasks.ts apps/web-ui/components/agent/chat-interface.tsx
git commit -m "feat(agent-ops): add Convert-chat-to-scheduled-task button to AIOps chat"
```

---

### Task 4: Scheduled Tasks page prefill detection (consumer) + manual verify

**Files:**
- Modify: `apps/web-ui/app/app/agent-ops/scheduled-tasks/page.tsx`

**Interfaces:**
- Consumes: `SCHEDULED_TASK_PREFILL_KEY`, `ScheduledTaskPrefill` (from Task 2); `ScheduledTaskDialog` `prefill`/`open`/`onOpenChange` props (Task 2); `useSearchParams`, `useRouter` (already imported on the page).

- [ ] **Step 1: Import the prefill key + type**

In `apps/web-ui/app/app/agent-ops/scheduled-tasks/page.tsx`, extend the existing dialog import:

```tsx
import { ScheduledTaskDialog, SCHEDULED_TASK_PREFILL_KEY, type ScheduledTaskPrefill } from "@/components/agent-ops/scheduled-task-dialog"
```

Add `useEffect` to the React import at the top:

```tsx
import { useState, useEffect } from "react"
```

- [ ] **Step 2: Read + clear the prefill on mount when `?prefill=1`**

Inside `ScheduledTasksPage`, after the existing `const [actionIds, ...]` state declarations, add:

```tsx
    const [prefill, setPrefill] = useState<ScheduledTaskPrefill | null>(null)
    const [prefillOpen, setPrefillOpen] = useState(false)

    useEffect(() => {
        if (searchParams.get("prefill") !== "1") return
        try {
            const raw = sessionStorage.getItem(SCHEDULED_TASK_PREFILL_KEY)
            if (raw) {
                setPrefill(JSON.parse(raw) as ScheduledTaskPrefill)
                setPrefillOpen(true)
            }
        } catch { /* ignore malformed draft */ }
        sessionStorage.removeItem(SCHEDULED_TASK_PREFILL_KEY)
        // strip the query param so a refresh doesn't re-open the dialog
        router.replace("/app/agent-ops/scheduled-tasks")
    }, [searchParams, router])
```

- [ ] **Step 3: Render the controlled prefilled dialog**

Still inside the page's returned JSX, immediately after the header `<ScheduledTaskDialog tenantId={tenantId} onSaved={() => tasksQuery.refetch()} />` (line ~137), add a second, controlled instance:

```tsx
                    {prefill && (
                        <ScheduledTaskDialog
                            tenantId={tenantId}
                            prefill={prefill}
                            open={prefillOpen}
                            onOpenChange={(o) => { setPrefillOpen(o); if (!o) setPrefill(null); }}
                            onSaved={() => { setPrefillOpen(false); setPrefill(null); tasksQuery.refetch(); }}
                        />
                    )}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "scheduled-tasks/page" || echo "no new page errors"`
Expected: `no new page errors`.

- [ ] **Step 5: Full test + lint gate**

Run: `cd apps/web-ui && bun run test -- distill/route.test.ts && bun run lint 2>&1 | tail -5`
Expected: distill tests PASS; lint reports no new errors in the touched files.

- [ ] **Step 6: Manual verify (superpowers:verify)**

Start the app (`cd apps/web-ui && bun run dev`), open the AIOps chat, run a short conversation that includes at least one tool call, then:
1. Click the new calendar-plus button in the chat header.
2. Confirm navigation to `/app/agent-ops/scheduled-tasks` and that the create dialog auto-opens.
3. Confirm Task Name, Objective (a concrete self-contained prompt with real identifiers retained), and cron are pre-filled; `autoApprove` off and notification `none`.
4. Click Save → confirm the task is created and appears in the list.
5. Refresh the page → confirm the dialog does NOT re-open (query param + sessionStorage cleared).

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/app/app/agent-ops/scheduled-tasks/page.tsx
git commit -m "feat(agent-ops): auto-open prefilled scheduled-task dialog from converted chat"
```

---

## Self-Review Notes

- **Spec coverage:** flow (Tasks 3+4), distill prompt/route + reuse/guards/RBAC (Task 1), `prefill` prop + controlled open + shared key/type (Task 2), query hook + button (Task 3), page detection + safe defaults + refresh-safety (Task 4), unit + manual tests (Tasks 1 & 4). All spec sections mapped.
- **Type consistency:** draft shape `{ name, prompt, suggestedCron, cadenceLabel }` is identical across route (Task 1), hook `ScheduledTaskDraft` (Task 3), and test (Task 1). The sessionStorage payload is `{ name, description, cronExpression }` matching `ScheduledTaskPrefill` (Task 2) consumed in Task 4. `SCHEDULED_TASK_PREFILL_KEY` defined once (Task 2), imported by Tasks 3 & 4.
- **Defaults:** `autoApprove=false` / `notification=none` come from `DEFAULT_FORM` (untouched); prefill only overrides `name`/`description`/`cronExpression`.
