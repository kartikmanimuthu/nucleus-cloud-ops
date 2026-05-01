import type { AgentOpsRun, AgentOpsEvent } from "./types"
import { formatDateTime } from '@/lib/date-utils';

const EVENT_META: Record<string, { label: string; bg: string; color: string }> = {
    planning: { label: "Planning", bg: "#dbeafe", color: "#1d4ed8" },
    execution: { label: "Execution", bg: "#dcfce7", color: "#15803d" },
    tool_call: { label: "Tool Call", bg: "#ffedd5", color: "#c2410c" },
    tool_result: { label: "Tool Result", bg: "#ccfbf1", color: "#0f766e" },
    reflection: { label: "Reflection", bg: "#f3e8ff", color: "#7e22ce" },
    revision: { label: "Revision", bg: "#e0e7ff", color: "#4338ca" },
    final: { label: "Final", bg: "#dcfce7", color: "#166534" },
    error: { label: "Error", bg: "#fee2e2", color: "#dc2626" },
}

const TIMELINE_COLORS: Record<string, string> = {
    planning: "#3b82f6", execution: "#22c55e", tool_call: "#f97316",
    tool_result: "#14b8a6", reflection: "#a855f7", revision: "#6366f1",
    final: "#16a34a", error: "#ef4444",
}

function formatTime(iso: string, timeZone?: string) {
    return formatDateTime(iso, 'longDateTime', timeZone);
}

function formatDuration(ms?: number) {
    if (!ms) return "—"
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}m`
}

function esc(str: string) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

// ─── Inline-style helpers ────────────────────────────────────────────────────

const S = {
    body: `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;color:#111827;background:#ffffff;padding:32px;margin:0;`,
    h1: `font-size:22px;font-weight:700;margin:0 0 4px 0;color:#111827;`,
    runId: `font-family:monospace;font-size:11px;color:#6b7280;margin-bottom:24px;display:block;`,
    sectionWrap: `margin-bottom:24px;`,
    h2: `font-size:13px;font-weight:700;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin:0 0 12px 0;`,
    metaRow: `display:table;width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:16px;`,
    metaCell: `display:table-cell;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;background:#ffffff;`,
    metaLabel: `font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;`,
    metaValue: `font-size:13px;font-weight:600;color:#111827;`,
    taskBox: `background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;font-size:13px;color:#111827;line-height:1.6;`,
    resultBox: `background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;font-size:12px;color:#111827;white-space:pre-wrap;word-break:break-word;line-height:1.6;margin-bottom:10px;`,
    errorBox: `background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;font-size:12px;color:#dc2626;white-space:pre-wrap;font-family:monospace;`,
    toolBadge: `display:inline-block;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #d1d5db;color:#374151;margin:2px 3px 2px 0;background:#ffffff;`,
    skillBadge: `display:inline-block;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #d1d5db;color:#374151;margin-top:8px;background:#ffffff;`,
    metaNote: `font-size:11px;color:#6b7280;margin-top:6px;`,
    timelineWrap: `border-left:3px solid #e5e7eb;padding-left:18px;margin-top:4px;`,
    eventWrap: `margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #f3f4f6;position:relative;`,
    eventHeader: `display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;`,
    eventIdx: `font-size:10px;color:#9ca3af;min-width:18px;`,
    eventNode: `font-family:monospace;font-size:10px;background:#f3f4f6;padding:2px 6px;border-radius:4px;color:#374151;`,
    eventTool: `font-family:monospace;font-size:10px;border:1px solid #d1d5db;padding:2px 6px;border-radius:4px;color:#374151;background:#fff;`,
    eventTokens: `font-size:10px;color:#9ca3af;`,
    eventTime: `font-size:10px;color:#9ca3af;margin-left:auto;`,
    argsWrap: `background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:10px;margin-bottom:8px;`,
    argsLabel: `font-size:10px;font-weight:600;color:#92400e;margin-bottom:4px;`,
    argsPre: `font-size:10px;white-space:pre-wrap;word-break:break-all;color:#9a3412;font-family:monospace;line-height:1.5;`,
    contentDefault: `font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.6;color:#374151;padding:4px 0;`,
    contentToolResult: `font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.6;background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;padding:10px;color:#134e4a;`,
    contentError: `font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.6;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;color:#dc2626;`,
    contentThinking: `font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.6;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px;padding:10px;color:#6b7280;font-style:italic;`,
    footer: `margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center;`,
}

function metaCard(label: string, value: string, extra = "") {
    return `<td style="${S.metaCell}${extra}"><div style="${S.metaLabel}">${label}</div><div style="${S.metaValue}">${value}</div></td>`
}

function eventLabelBadge(eventType: string, isThinking: boolean) {
    const meta = EVENT_META[eventType] ?? { label: eventType, bg: "#f3f4f6", color: "#374151" }
    const label = isThinking ? "Thinking" : meta.label
    return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:${meta.bg};color:${meta.color};">${label}</span>`
}

export function buildRunReportHtml(run: AgentOpsRun, events: AgentOpsEvent[], timeZone?: string): string {
    const tokenTotals = events.reduce(
        (acc, e) => {
            if (e.metadata) {
                acc.input += (e.metadata.inputTokens as number) || 0
                acc.output += (e.metadata.outputTokens as number) || 0
            }
            return acc
        },
        { input: 0, output: 0 }
    )

    // ── Event rows ──────────────────────────────────────────────────────────
    const eventRows = events.map((e, idx) => {
        const isThinking = e.metadata?.contentType === "thinking"
        const dotColor = TIMELINE_COLORS[e.eventType] ?? "#9ca3af"
        const mainContent = e.content || e.toolOutput || ""
        const tokens = e.metadata
            ? ((e.metadata.inputTokens as number) || 0) + ((e.metadata.outputTokens as number) || 0)
            : 0

        const argsBlock = e.toolArgs && Object.keys(e.toolArgs).length > 0
            ? `<div style="${S.argsWrap}">
                 <div style="${S.argsLabel}">Args</div>
                 <pre style="${S.argsPre}">${esc(JSON.stringify(e.toolArgs, null, 2))}</pre>
               </div>`
            : ""

        let contentStyle = S.contentDefault
        if (isThinking) contentStyle = S.contentThinking
        else if (e.eventType === "tool_result") contentStyle = S.contentToolResult
        else if (e.eventType === "error") contentStyle = S.contentError

        const contentBlock = mainContent
            ? `<div style="${contentStyle}">${esc(mainContent)}</div>`
            : ""

        return `
        <div style="${S.eventWrap}">
          <div style="position:absolute;left:-24px;top:4px;width:10px;height:10px;border-radius:50%;background:${dotColor};border:2px solid #fff;box-shadow:0 0 0 1px ${dotColor};"></div>
          <div style="${S.eventHeader}">
            <span style="${S.eventIdx}">${idx + 1}</span>
            ${eventLabelBadge(e.eventType, isThinking)}
            <span style="${S.eventNode}">${esc(e.node)}</span>
            ${e.toolName ? `<span style="${S.eventTool}">${esc(e.toolName)}</span>` : ""}
            ${tokens > 0 ? `<span style="${S.eventTokens}">${tokens} tk</span>` : ""}
            <span style="${S.eventTime}">${formatTime(e.createdAt, timeZone)}</span>
          </div>
          ${argsBlock}
          ${contentBlock}
        </div>`
    }).join("")

    // ── Result section ──────────────────────────────────────────────────────
    const toolBadges = run.result?.toolsUsed?.length
        ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;">
             <span style="font-size:11px;color:#6b7280;margin-right:4px;">Tools used:</span>
             ${run.result.toolsUsed.map(t => `<span style="${S.toolBadge}">${esc(t)}</span>`).join("")}
           </div>`
        : ""

    const resultSection = run.result?.summary ? `
        <div style="${S.sectionWrap}">
          <div style="${S.h2}">✅ Result</div>
          <div style="${S.resultBox}">${esc(run.result.summary)}</div>
          ${toolBadges}
          ${run.result.iterations ? `<div style="${S.metaNote}">${run.result.iterations} iteration(s)</div>` : ""}
        </div>` : ""

    const errorSection = run.error ? `
        <div style="${S.sectionWrap}">
          <div style="${S.h2}" style="color:#dc2626;">❌ Error</div>
          <div style="${S.errorBox}">${esc(run.error)}</div>
        </div>` : ""

    // ── Status badge color ──────────────────────────────────────────────────
    const statusColors: Record<string, string> = {
        completed: "background:#dcfce7;color:#166534;",
        failed: "background:#fee2e2;color:#dc2626;",
        in_progress: "background:#dbeafe;color:#1d4ed8;",
        cancelled: "background:#f3f4f6;color:#6b7280;",
    }
    const statusStyle = statusColors[run.status] ?? "background:#f3f4f6;color:#374151;"

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><title>Agent Ops Run Report</title></head>
<body style="${S.body}">

  <!-- Header -->
  <div style="margin-bottom:24px;">
    <h1 style="${S.h1}">⚡ Agent Ops Run Report</h1>
    <span style="${S.runId}">${esc(run.runId)}</span>
    <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;${statusStyle}">
      ${run.status.replace(/_/g, " ").toUpperCase()}
    </span>
  </div>

  <!-- Meta grid row 1 -->
  <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:8px;">
    <tr>
      ${metaCard("Source", `<span style="text-transform:capitalize">${esc(run.source)}</span>`)}
      ${metaCard("Mode", `<span style="text-transform:capitalize">${esc(run.mode)}</span>`)}
      ${metaCard("Duration", formatDuration(run.durationMs))}
      ${metaCard("Tokens", tokenTotals.input + tokenTotals.output > 0 ? `${tokenTotals.input}↑ ${tokenTotals.output}↓` : "—")}
      ${metaCard("Events", String(events.length))}
    </tr>
  </table>

  <!-- Meta grid row 2 -->
  <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:24px;">
    <tr>
      ${metaCard("Started", formatTime(run.createdAt, timeZone))}
      ${run.completedAt ? metaCard("Completed", formatTime(run.completedAt, timeZone)) : "<td></td>"}
      <td></td><td></td><td></td>
    </tr>
  </table>

  <!-- Task Description -->
  <div style="${S.sectionWrap}">
    <div style="${S.h2}">Task Description</div>
    <div style="${S.taskBox}">
      ${esc(run.taskDescription)}
      ${run.selectedSkill ? `<div><span style="${S.skillBadge}">Skill: ${esc(run.selectedSkill)}</span></div>` : ""}
      ${run.accountName ? `<div style="${S.metaNote}">Account: ${esc(run.accountName)} (${esc(run.accountId ?? "")})</div>` : ""}
    </div>
  </div>

  ${resultSection}
  ${errorSection}

  <!-- Execution Timeline -->
  <div style="${S.sectionWrap}">
    <div style="${S.h2}">
      Execution Timeline
      <span style="font-weight:400;font-size:11px;color:#6b7280;margin-left:6px;">(${events.length} events)</span>
    </div>
    <div style="${S.timelineWrap}">
      ${eventRows || `<p style="color:#9ca3af;font-size:12px;">No events recorded.</p>`}
    </div>
  </div>

  <!-- Footer -->
  <div style="${S.footer}">
    Generated ${formatDateTime(new Date(), 'longDateTime', timeZone)} · Nucleus Cloud Ops
  </div>

</body>
</html>`
}

export async function exportRunToPdf(run: AgentOpsRun, events: AgentOpsEvent[]): Promise<void> {
    const html2pdf = (await import("html2pdf.js")).default

    const html = buildRunReportHtml(run, events)
    const filename = `agent-ops-run-${run.runId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.pdf`

    const iframe = document.createElement("iframe")
    iframe.style.cssText = "position:fixed;top:0;left:0;width:794px;height:1123px;opacity:0;pointer-events:none;z-index:-9999;border:none;"
    document.body.appendChild(iframe)

    await new Promise<void>((resolve) => {
        iframe.onload = () => resolve()
        iframe.srcdoc = html
    })

    // Give the iframe a tick to finish layout
    await new Promise(r => setTimeout(r, 300))

    const iframeDoc = iframe.contentDocument!
    const target = iframeDoc.body

    try {
        await html2pdf()
            .set({
                margin: [8, 8, 8, 8],
                filename,
                image: { type: "jpeg", quality: 0.98 },
                html2canvas: {
                    scale: 2,
                    useCORS: true,
                    logging: false,
                    windowWidth: 794,
                    scrollY: 0,
                },
                jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
            })
            .from(target)
            .save()
    } finally {
        document.body.removeChild(iframe)
    }
}
