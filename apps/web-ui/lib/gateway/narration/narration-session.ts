// web-ui/lib/gateway/narration/narration-session.ts
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import type { ResolvedModelConfig } from '@/lib/agent/agent-shared';
import { isStepBoundary } from '@/lib/agent-ops/record-and-emit';
import { translateEventWithFallback } from '@/lib/gateway/narration/translate-event';
import { ChannelRateLimiter } from '@/lib/gateway/utils/rate-limiter';
import {
    createChecklist,
    addStep,
    completeStep,
    renderChecklist,
    type ChecklistState,
    type StepPhrase,
} from './checklist';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

const DEFAULT_MIN_INTERVAL_MS = 2000;

/**
 * Deep runs tag both tool_call and tool_result with metadata.toolCallId and
 * drain run.toolCalls in parallel watchers, so two concurrent same-named tool
 * calls can settle out of order — keying the checklist by toolName alone ticks
 * the wrong step done. Prefer the id when the event carries one; plan-mode
 * events never do, so they fall back to toolName unchanged.
 */
function correlationKeyOf(event: AgentOpsEvent): string | undefined {
    const id = (event.metadata as { toolCallId?: unknown } | undefined)?.toolCallId;
    return typeof id === 'string' ? id : event.toolName;
}

/**
 * Per-run narration bookkeeping shared by every narrating channel adapter.
 * Owns the checklist, the resolved-model cache, the finished-run guard, and
 * the send throttle; adapters own only their transport.
 */
export class NarrationSessions {
    private checklists = new Map<string, ChecklistState>();
    private modelCache = new Map<string, ResolvedModelConfig>();
    private finishedRuns = new Set<string>();
    private rateLimiter: ChannelRateLimiter;

    constructor(minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS) {
        this.rateLimiter = new ChannelRateLimiter(minIntervalMs);
    }

    /**
     * Fold an event into the run's checklist and return the text to render, or
     * null when nothing should go out: a non-boundary event, a run that already
     * delivered its result, a throttled send, or a narration failure.
     *
     * A throttled call still advances checklist state, so a suppressed update is
     * never lost — it folds into the next send.
     */
    async applyEvent(run: AgentOpsRun, event: AgentOpsEvent): Promise<string | null> {
        if (!isStepBoundary(event.eventType)) return null;
        // GatewayEventBus.emit doesn't await subscribers, so a narration update
        // can still be in flight when the final result lands. Never overwrite it.
        if (this.finishedRuns.has(run.runId)) return null;

        try {
            let checklist = this.checklists.get(run.runId) ?? createChecklist();

            if (event.eventType === 'tool_result') {
                checklist = completeStep(checklist, correlationKeyOf(event));
            } else {
                const phrase = await this.translate(run, event);
                checklist = event.eventType === 'tool_call'
                    ? addStep(checklist, phrase, { key: correlationKeyOf(event) })
                    // planning / reflection are finished milestones, not work in flight.
                    : addStep(checklist, phrase, { done: true });
            }

            this.checklists.set(run.runId, checklist);

            if (!this.rateLimiter.shouldSend(run.runId)) return null;
            return renderChecklist(checklist);
        } catch (err) {
            console.warn('[NarrationSessions] Narration failed (non-fatal):', err);
            return null;
        }
    }

    /** Mark a run finished and drop its state. Idempotent. */
    finish(runId: string): void {
        this.finishedRuns.add(runId);
        this.checklists.delete(runId);
        this.modelCache.delete(runId);
        this.rateLimiter.reset(runId);
    }

    isFinished(runId: string): boolean {
        return this.finishedRuns.has(runId);
    }

    private async translate(run: AgentOpsRun, event: AgentOpsEvent): Promise<StepPhrase> {
        return translateEventWithFallback(event, await this.resolveRunModel(run), run.accountName);
    }

    private async resolveRunModel(run: AgentOpsRun): Promise<ResolvedModelConfig> {
        const cached = this.modelCache.get(run.runId);
        if (cached) return cached;
        const config = run.model
            ? await resolveModelConfig(run.model, run.tenantId)
            : await resolveDefaultModelConfig(run.tenantId);
        this.modelCache.set(run.runId, config);
        return config;
    }
}
