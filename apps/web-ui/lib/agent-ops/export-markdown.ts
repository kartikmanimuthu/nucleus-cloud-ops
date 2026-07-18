/**
 * Agent Ops run → Markdown report.
 *
 * Companion to export-pdf.ts: same data, same buildSteps() step model as the
 * on-screen timeline, rendered as a self-contained .md document (the pattern
 * users know from the AI Ops chat export in lib/chat-export.ts).
 *
 * buildRunReportMarkdown() is pure (unit-tested); exportRunToMarkdown() wraps
 * it in a Blob download.
 */

import type { AgentOpsRun, AgentOpsEvent } from "./types"
import { formatDateTime } from '@/lib/date-utils';
import { buildSteps, type TimelineStep } from "@/components/agent-ops/run-timeline/build-steps";

function formatTime(iso: string, timeZone?: string) {
    return formatDateTime(iso, 'longDateTime', timeZone);
}

function formatDuration(ms?: number) {
    if (!ms) return "—"
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Wrap content in a code fence that cannot be terminated early: the fence is
 * one backtick longer than the longest backtick run inside the content.
 */
function fence(content: string, lang = ""): string {
    const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
    const marker = "`".repeat(Math.max(3, longestRun + 1))
    return `${marker}${lang}\n${content}\n${marker}`
}

const STEP_ICONS: Record<string, string> = {
    memory: "🧠",
    evaluation: "🧭",
    planning: "📋",
    thinking: "💭",
    tool: "🔧",
    reflection: "🔍",
    final: "✅",
    error: "❌",
}

export function buildRunReportMarkdown(
    run: AgentOpsRun,
    events: AgentOpsEvent[],
    timeZone?: string,
): string {
    const lines: string[] = []
    const push = (...ls: string[]) => { lines.push(...ls) }

    const tokens = events.reduce(
        (acc, e) => {
            acc.input += (e.metadata?.inputTokens as number) || 0
            acc.output += (e.metadata?.outputTokens as number) || 0
            return acc
        },
        { input: 0, output: 0 },
    )
    const tokenStr = tokens.input + tokens.output > 0
        ? `${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`
        : "—"

    // ── Header + metadata ───────────────────────────────────────────────────
    push(
        `# Agent Ops Run Report`,
        ``,
        `\`${run.runId}\` · **${run.status.replace(/_/g, " ").toUpperCase()}**`,
        ``,
        `| Source | Mode | Duration | Tokens | Events | Started |${run.completedAt ? " Completed |" : ""}`,
        `|---|---|---|---|---|---|${run.completedAt ? "---|" : ""}`,
        `| ${run.source} | ${run.mode} | ${formatDuration(run.durationMs)} | ${tokenStr} | ${events.length} | ${formatTime(run.createdAt, timeZone)} |${run.completedAt ? ` ${formatTime(run.completedAt, timeZone)} |` : ""}`,
        ``,
    )

    // ── Task ────────────────────────────────────────────────────────────────
    push(`## Task Description`, ``, run.taskDescription, ``)
    const taskMeta = [
        run.selectedSkill ? `**Skill:** ${run.selectedSkill}` : "",
        run.accountName ? `**Account:** ${run.accountName}${run.accountId ? ` (${run.accountId})` : ""}` : "",
    ].filter(Boolean)
    if (taskMeta.length) push(taskMeta.join(" · "), ``)

    // ── Result / Error ──────────────────────────────────────────────────────
    if (run.result?.summary) {
        push(`## Result`, ``, run.result.summary, ``)
        if (run.result.toolsUsed?.length) push(`**Tools used:** ${run.result.toolsUsed.join(", ")}`, ``)
        if (run.result.iterations) push(`*${run.result.iterations} iteration(s)*`, ``)
    }
    if (run.error) {
        push(`## Error`, ``, fence(run.error), ``)
    }

    // ── Execution Timeline ──────────────────────────────────────────────────
    // Same step model as the UI timeline and the PDF. Groups render EXPANDED:
    // a document can't be clicked open, so every grouped tool call is inlined.
    push(`## Execution Timeline (${events.length} events)`, ``)

    const steps = buildSteps(events, run.status)
    if (steps.length === 0) push(`*No events recorded.*`, ``)

    const t = (e: AgentOpsEvent) => formatTime(e.createdAt, timeZone)

    function renderStep(step: TimelineStep, depth: number) {
        // Group children render one heading level deeper (#### instead of ###).
        const h = "#".repeat(Math.min(3 + depth, 6))

        switch (step.kind) {
            case "group": {
                const toolCount = step.steps.filter(s => s.kind === "tool").length
                const dur = step.durationMs > 0 ? ` · ${formatDuration(step.durationMs)}` : ""
                push(`${h} ⚙️ Worked — ${toolCount} tool call${toolCount === 1 ? "" : "s"}${dur}`, ``)
                for (const s of step.steps) renderStep(s, depth + 1)
                break
            }
            case "tool": {
                const anchor = step.call ?? step.result
                const statusMark = step.status === "error" ? "✗" : step.status === "running" ? "…" : "✓"
                const dur = step.durationMs !== undefined ? ` ${formatDuration(step.durationMs)}` : ""
                push(`${h} ${STEP_ICONS.tool} Tool: \`${step.toolName}\` ${statusMark}${dur}${anchor ? ` — ${t(anchor)}` : ""}`, ``)
                const args = step.call?.toolArgs
                const output = step.result?.toolOutput ?? step.result?.content
                if (args && Object.keys(args).length > 0) {
                    push(`**Arguments:**`, ``, fence(JSON.stringify(args, null, 2), "json"), ``)
                }
                if (output) {
                    push(`**Output:**`, ``, fence(output), ``)
                }
                if (!args && !output) push(`*No detail captured.*`, ``)
                break
            }
            case "planning":
                push(`${h} ${STEP_ICONS.planning} Planning — ${t(step.event)}`, ``)
                if (step.event.content) push(step.event.content, ``)
                break
            case "reflection":
                push(`${h} ${STEP_ICONS.reflection} ${step.event.eventType === "revision" ? "Revision" : "Reflection"} — ${t(step.event)}`, ``)
                if (step.event.content) push(step.event.content, ``)
                break
            case "thinking":
                if (!step.event.content) break
                push(`${h} ${STEP_ICONS.thinking} Thinking — ${t(step.event)}`, ``)
                push(step.event.content, ``)
                break
            case "evaluation": {
                const m = (step.event.metadata ?? {}) as Record<string, unknown>
                const kbs = (m.knowledgeBaseIds as unknown[] | undefined) ?? []
                const badges = [
                    m.mode ? `${m.mode} mode` : "",
                    (m.skillName || m.skillId) ? `skill: ${m.skillName ?? m.skillId}` : "",
                    kbs.length ? `KB ×${kbs.length}` : "",
                    m.requiresApproval ? "approval required" : "",
                ].filter(Boolean).join(" · ")
                push(`${h} ${STEP_ICONS.evaluation} Evaluated request — ${t(step.event)}`, ``)
                if (badges) push(`*${badges}*`, ``)
                if (step.event.content) push(step.event.content, ``)
                break
            }
            case "memory": {
                const m = (step.event.metadata ?? {}) as Record<string, unknown>
                const title = step.event.content || (step.phase === "recall" ? "Memory recall" : "Memory save")
                push(`${h} ${STEP_ICONS.memory} ${title} — ${t(step.event)}`, ``)
                if (step.phase === "recall") {
                    const parts = [
                        (m.facts as unknown[])?.length ? `${(m.facts as unknown[]).length} fact(s)` : "",
                        (m.rules as unknown[])?.length ? `${(m.rules as unknown[]).length} rule(s)` : "",
                        (m.episodes as unknown[])?.length ? `${(m.episodes as unknown[]).length} episode(s)` : "",
                    ].filter(Boolean).join(" · ")
                    if (parts) push(`*${parts}*`, ``)
                } else if (m.savedFacts !== undefined) {
                    push(`*${m.savedFacts ?? 0} fact(s), ${m.savedRules ?? 0} rule(s) saved · episode: ${m.episodeCaptured ? "yes" : "no"}*`, ``)
                }
                break
            }
            case "final":
                push(`${h} ${STEP_ICONS.final} ${step.event.node === "__cancelled__" ? "Run cancelled" : "Final summary"} — ${t(step.event)}`, ``)
                if (step.event.content) push(step.event.content, ``)
                break
            case "error":
                push(`${h} ${STEP_ICONS.error} Error — ${t(step.event)}`, ``)
                if (step.event.content) push(fence(step.event.content), ``)
                break
        }
    }

    for (const step of steps) renderStep(step, 0)

    push(`---`, ``, `*Generated ${formatDateTime(new Date(), 'longDateTime', timeZone)} · Nucleus Cloud Ops*`)

    return lines.join("\n")
}

/** Build the report and trigger a browser download (same pattern as chat-export.ts). */
export function exportRunToMarkdown(
    run: AgentOpsRun,
    events: AgentOpsEvent[],
    timeZone?: string,
): void {
    const markdown = buildRunReportMarkdown(run, events, timeZone)
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `agent-ops-run-${run.runId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}
