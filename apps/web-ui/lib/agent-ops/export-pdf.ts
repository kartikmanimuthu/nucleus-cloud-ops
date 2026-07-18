import type { AgentOpsRun, AgentOpsEvent } from "./types"
import { formatDateTime } from '@/lib/date-utils';
import { buildSteps, type TimelineStep } from "@/components/agent-ops/run-timeline/build-steps";

const EVENT_META: Record<string, { label: string; bg: string; color: string }> = {
    planning: { label: "Planning", bg: "#dbeafe", color: "#1d4ed8" },
    execution: { label: "Execution", bg: "#dcfce7", color: "#15803d" },
    tool_call: { label: "Tool Call", bg: "#ffedd5", color: "#c2410c" },
    tool_result: { label: "Tool Result", bg: "#ccfbf1", color: "#0f766e" },
    reflection: { label: "Reflection", bg: "#f3e8ff", color: "#7e22ce" },
    revision: { label: "Revision", bg: "#e0e7ff", color: "#4338ca" },
    final: { label: "Final", bg: "#dcfce7", color: "#166534" },
    error: { label: "Error", bg: "#fee2e2", color: "#dc2626" },
    memory_recall: { label: "Memory Recall", bg: "#ede9fe", color: "#6d28d9" },
    memory_save:   { label: "Memory Save",   bg: "#ede9fe", color: "#6d28d9" },
    evaluation:    { label: "Evaluation",    bg: "#fef3c7", color: "#b45309" },
}

const TIMELINE_COLORS: Record<string, string> = {
    planning: "#3b82f6", execution: "#22c55e", tool_call: "#f97316",
    tool_result: "#14b8a6", reflection: "#a855f7", revision: "#6366f1",
    final: "#16a34a", error: "#ef4444",
    memory_recall: "#8b5cf6",
    memory_save: "#8b5cf6",
    evaluation: "#f59e0b",
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

    // The <title> becomes the browser's default "Save as PDF" filename.
    const docTitle = `agent-ops-run-${run.runId.slice(0, 8)}`

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${esc(docTitle)}</title>
  <style>
    @page { size: A4; margin: 8mm; }
    /* Force badge/section background colors to print (they carry meaning). */
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  </style>
</head>
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

// hex "#rrggbb" → [r,g,b] for jsPDF's setFillColor/setTextColor.
function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
    if (!m) return [55, 65, 81]
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/**
 * Export a run to PDF using jsPDF's vector text API — NOT html2canvas.
 *
 * Two earlier approaches failed:
 *  1. html2pdf/html2canvas rasterized the whole report into ONE canvas. Chrome
 *     silently caps canvas height at 65,535 px (transparent, no error), so long
 *     runs produced a blank PDF.
 *  2. Native window.print() has no canvas limit but opens the OS print dialog,
 *     which is dead-in-the-water on machines with no printer configured (macOS
 *     shows "No Printer Selected" and hides Save-as-PDF in a small menu).
 *
 * jsPDF text rendering has neither problem: no raster canvas (no size limit),
 * selectable text, tiny files, jsPDF.save() triggers a normal browser download
 * with a real filename on every OS. We paginate manually via a y-cursor.
 */
export async function exportRunToPdf(
    run: AgentOpsRun,
    events: AgentOpsEvent[],
    timeZone?: string
): Promise<void> {
    const { jsPDF } = await import("jspdf")
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" })

    const M = 12                 // page margin (mm)
    const PW = 210, PH = 297     // A4 (mm)
    const CW = PW - M * 2        // content width (mm)
    const PT = 0.352778          // 1 pt in mm
    let y = M

    const clean = (s: unknown) => String(s ?? "").replace(/\r/g, "").replace(/\t/g, "    ")
    const ensure = (h: number) => { if (y + h > PH - M) { doc.addPage(); y = M } }

    // Wrapped paragraph. Returns nothing; advances y (paginating as needed).
    function para(
        text: string,
        opts: { size?: number; color?: [number, number, number]; font?: string; style?: string; indent?: number; gap?: number } = {}
    ) {
        const { size = 9, color = [55, 65, 81], font = "helvetica", style = "normal", indent = 0, gap = 1.35 } = opts
        doc.setFont(font, style)
        doc.setFontSize(size)
        doc.setTextColor(color[0], color[1], color[2])
        const lh = size * PT * gap
        const lines: string[] = doc.splitTextToSize(clean(text), CW - indent)
        for (const ln of lines) {
            ensure(lh)
            doc.text(ln, M + indent, y + size * PT)  // baseline offset
            y += lh
        }
    }

    // Small filled label chip. Draws at (x, y-top); returns its width (mm).
    function chip(label: string, x: number, bgHex: string, fgHex: string): number {
        const size = 7.5
        doc.setFont("helvetica", "bold")
        doc.setFontSize(size)
        const w = doc.getTextWidth(label) + 3
        const h = 4.2
        const [br, bg, bb] = hexToRgb(bgHex)
        const [fr, fg, fb] = hexToRgb(fgHex)
        doc.setFillColor(br, bg, bb)
        doc.roundedRect(x, y, w, h, 0.8, 0.8, "F")
        doc.setTextColor(fr, fg, fb)
        doc.text(label, x + 1.5, y + h - 1.3)
        return w
    }

    function rule() {
        ensure(3)
        doc.setDrawColor(229, 231, 235)
        doc.setLineWidth(0.2)
        doc.line(M, y, PW - M, y)
        y += 3
    }

    // ── Header ────────────────────────────────────────────────────────────
    para("Agent Ops Run Report", { size: 18, style: "bold", color: [17, 24, 39], gap: 1.1 })
    para(run.runId, { size: 9, font: "courier", color: [107, 114, 128] })
    y += 1
    const statusMeta: Record<string, [string, string]> = {
        completed: ["#dcfce7", "#166534"], failed: ["#fee2e2", "#dc2626"],
        in_progress: ["#dbeafe", "#1d4ed8"], cancelled: ["#f3f4f6", "#6b7280"],
    }
    const [sbg, sfg] = statusMeta[run.status] ?? ["#f3f4f6", "#374151"]
    chip(run.status.replace(/_/g, " ").toUpperCase(), M, sbg, sfg)
    y += 7

    // ── Meta ──────────────────────────────────────────────────────────────
    const tokenTotals = events.reduce(
        (a, e) => {
            if (e.metadata) {
                a.input += (e.metadata.inputTokens as number) || 0
                a.output += (e.metadata.outputTokens as number) || 0
            }
            return a
        },
        { input: 0, output: 0 }
    )
    const tokenStr = tokenTotals.input + tokenTotals.output > 0
        ? `${tokenTotals.input.toLocaleString()} in / ${tokenTotals.output.toLocaleString()} out`
        : "—"
    const metaPairs: [string, string][] = [
        ["Source", clean(run.source)],
        ["Mode", clean(run.mode)],
        ["Duration", formatDuration(run.durationMs)],
        ["Tokens", tokenStr],
        ["Events", String(events.length)],
        ["Started", formatTime(run.createdAt, timeZone)],
    ]
    if (run.completedAt) metaPairs.push(["Completed", formatTime(run.completedAt, timeZone)])
    for (const [k, v] of metaPairs) {
        ensure(5)
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(107, 114, 128)
        doc.text(`${k}:`, M, y + 3)
        doc.setFont("helvetica", "normal"); doc.setTextColor(17, 24, 39)
        doc.text(clean(v), M + 26, y + 3)
        y += 5
    }
    y += 3

    // ── Task ──────────────────────────────────────────────────────────────
    para("Task Description", { size: 12, style: "bold", color: [55, 65, 81] })
    rule()
    para(run.taskDescription, { size: 10, color: [17, 24, 39] })
    if (run.selectedSkill) para(`Skill: ${run.selectedSkill}`, { size: 8, color: [107, 114, 128] })
    if (run.accountName) para(`Account: ${run.accountName} (${run.accountId ?? ""})`, { size: 8, color: [107, 114, 128] })
    y += 3

    // ── Result / Error ──────────────────────────────────────────────────────
    if (run.result?.summary) {
        para("Result", { size: 12, style: "bold", color: [22, 101, 52] })
        rule()
        para(run.result.summary, { size: 9, color: [17, 24, 39] })
        if (run.result.toolsUsed?.length) para(`Tools used: ${run.result.toolsUsed.join(", ")}`, { size: 8, color: [107, 114, 128] })
        if (run.result.iterations) para(`${run.result.iterations} iteration(s)`, { size: 8, color: [107, 114, 128] })
        y += 3
    }
    if (run.error) {
        para("Error", { size: 12, style: "bold", color: [220, 38, 38] })
        rule()
        para(run.error, { size: 9, font: "courier", color: [220, 38, 38] })
        y += 3
    }

    // ── Execution Timeline ──────────────────────────────────────────────────
    // Reuse the SAME step model the web UI builds (run-timeline/build-steps.ts)
    // so the PDF and the on-screen timeline never drift: tool_call + tool_result
    // are paired into one Tool step (name, arguments, output, status, duration),
    // and steps carry the same kinds/labels/colors as the UI. The ONE deliberate
    // difference: the UI folds long work runs into collapsible "Worked — N tool
    // calls" groups, but a PDF can't be clicked open, so groups are rendered
    // EXPANDED here and every tool call shows its arguments + output inline.
    para(`Execution Timeline (${events.length} events)`, { size: 12, style: "bold", color: [55, 65, 81] })
    rule()

    const steps = buildSteps(events, run.status)
    if (steps.length === 0) {
        para("No events recorded.", { size: 9, color: [156, 163, 175] })
    }

    const fmtDur = (ms?: number) =>
        ms === undefined ? "" : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`
    const firstLine = (t?: string, n = 110) => {
        if (!t) return ""
        const l = clean(t).split("\n").find((s) => s.trim()) ?? ""
        return l.length > n ? `${l.slice(0, n)}…` : l
    }

    type Chip = { label: string; bg: string; fg: string }
    const KIND: Record<string, Chip> = {
        memory:     { label: "Memory",     bg: "#ede9fe", fg: "#6d28d9" },
        evaluation: { label: "Evaluated",  bg: "#fef3c7", fg: "#b45309" },
        planning:   { label: "Planning",   bg: "#dbeafe", fg: "#1d4ed8" },
        thinking:   { label: "Thinking",   bg: "#f3f4f6", fg: "#6b7280" },
        tool:       { label: "Tool",       bg: "#e0f2fe", fg: "#0369a1" },
        reflection: { label: "Reflection", bg: "#f3e8ff", fg: "#7e22ce" },
        final:      { label: "Final",      bg: "#dcfce7", fg: "#166534" },
        error:      { label: "Error",      bg: "#fee2e2", fg: "#dc2626" },
    }

    // Header row for a step: chip + optional title (+ status) + right-aligned time.
    function stepHead(
        chipLabel: string,
        c: Chip,
        indent: number,
        opts: { title?: string; titleMono?: boolean; status?: string; statusColor?: [number, number, number]; time?: string } = {}
    ) {
        ensure(6)
        const x0 = M + indent
        const cw = chip(chipLabel, x0, c.bg, c.fg)
        let cx = x0 + cw + 2
        const timeStr = opts.time ?? ""
        let timeW = 0
        if (timeStr) {
            doc.setFont("helvetica", "normal"); doc.setFontSize(7.5)
            timeW = doc.getTextWidth(timeStr)
        }
        const rightEdge = PW - M - (timeW ? timeW + 2 : 0)
        if (opts.title) {
            doc.setFont(opts.titleMono ? "courier" : "helvetica", opts.titleMono ? "normal" : "bold")
            doc.setFontSize(9); doc.setTextColor(17, 24, 39)
            const t = (doc.splitTextToSize(clean(opts.title), Math.max(20, rightEdge - cx - 2))[0] as string) ?? ""
            doc.text(t, cx, y + 3)
            cx += doc.getTextWidth(t) + 3
        }
        if (opts.status) {
            doc.setFont("helvetica", "normal"); doc.setFontSize(8)
            const sc = opts.statusColor ?? [107, 114, 128]
            doc.setTextColor(sc[0], sc[1], sc[2])
            doc.text(opts.status, cx, y + 3)
        }
        if (timeStr) {
            doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(156, 163, 175)
            doc.text(timeStr, PW - M - timeW, y + 3)
        }
        y += 6
    }

    function renderStep(step: TimelineStep, indent: number) {
        const bodyIndent = indent + 4
        const t = (e: AgentOpsEvent) => formatTime(e.createdAt, timeZone)

        switch (step.kind) {
            case "group": {
                const toolCount = step.steps.filter((s) => s.kind === "tool").length
                ensure(6)
                doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(107, 114, 128)
                const dur = step.durationMs > 0 ? `  ·  ${fmtDur(step.durationMs)}` : ""
                doc.text(`Worked — ${toolCount} tool call${toolCount === 1 ? "" : "s"}${dur}`, M + indent, y + 3)
                y += 6
                for (const s of step.steps) renderStep(s, indent + 4)
                y += 1
                break
            }
            case "tool": {
                const anchor = step.call ?? step.result
                const statusLabel = step.status === "error" ? "failed" : step.status === "running" ? "running" : ""
                const statusColor: [number, number, number] = step.status === "error" ? [220, 38, 38] : [107, 114, 128]
                stepHead(KIND.tool.label, KIND.tool, indent, {
                    title: step.toolName,
                    titleMono: true,
                    status: [statusLabel, step.durationMs !== undefined ? fmtDur(step.durationMs) : ""].filter(Boolean).join("  "),
                    statusColor,
                    time: anchor ? t(anchor) : undefined,
                })
                const args = step.call?.toolArgs
                const output = step.result?.toolOutput ?? step.result?.content
                if (args && Object.keys(args).length > 0) {
                    para("ARGUMENTS", { size: 7, style: "bold", color: [107, 114, 128], indent: bodyIndent })
                    para(JSON.stringify(args, null, 2), { size: 7.5, font: "courier", color: [55, 65, 81], indent: bodyIndent, gap: 1.25 })
                }
                if (output) {
                    para("OUTPUT", { size: 7, style: "bold", color: [107, 114, 128], indent: bodyIndent })
                    para(output, { size: 7.5, font: "courier", color: step.status === "error" ? [220, 38, 38] : [55, 65, 81], indent: bodyIndent, gap: 1.25 })
                }
                if (!args && !output) para("No detail captured.", { size: 8, color: [156, 163, 175], indent: bodyIndent })
                y += 1.5
                break
            }
            case "planning":
                stepHead(KIND.planning.label, KIND.planning, indent, { title: firstLine(step.event.content) || "Planning", time: t(step.event) })
                if (step.event.content) para(step.event.content, { size: 8.5, color: [55, 65, 81], indent: bodyIndent })
                y += 1.5
                break
            case "reflection":
                stepHead(step.event.eventType === "revision" ? "Revision" : "Reflection", KIND.reflection, indent, { time: t(step.event) })
                if (step.event.content) para(step.event.content, { size: 8.5, color: [55, 65, 81], indent: bodyIndent })
                y += 1.5
                break
            case "thinking":
                if (!step.event.content) break
                stepHead(KIND.thinking.label, KIND.thinking, indent, { time: t(step.event) })
                para(step.event.content, { size: 8.5, color: [107, 114, 128], style: "italic", indent: bodyIndent })
                y += 1.5
                break
            case "evaluation": {
                const m = (step.event.metadata ?? {}) as Record<string, unknown>
                const kbs = (m.knowledgeBaseIds as unknown[] | undefined) ?? []
                const badges = [
                    m.mode ? `${m.mode} mode` : "",
                    (m.skillName || m.skillId) ? `skill: ${m.skillName ?? m.skillId}` : "",
                    kbs.length ? `KB ×${kbs.length}` : "",
                    m.requiresApproval ? "approval" : "",
                ].filter(Boolean).join("    ·    ")
                stepHead(KIND.evaluation.label, KIND.evaluation, indent, { title: "Evaluated request", time: t(step.event) })
                if (badges) para(badges, { size: 7.5, color: [107, 114, 128], indent: bodyIndent })
                if (step.event.content) para(step.event.content, { size: 8.5, color: [55, 65, 81], indent: bodyIndent })
                y += 1.5
                break
            }
            case "memory": {
                const m = (step.event.metadata ?? {}) as Record<string, unknown>
                stepHead(KIND.memory.label, KIND.memory, indent, {
                    title: step.event.content || (step.phase === "recall" ? "Memory recall" : "Memory save"),
                    time: t(step.event),
                })
                if (step.phase === "recall") {
                    const parts = [
                        (m.facts as unknown[])?.length ? `${(m.facts as unknown[]).length} fact(s)` : "",
                        (m.rules as unknown[])?.length ? `${(m.rules as unknown[]).length} rule(s)` : "",
                        (m.episodes as unknown[])?.length ? `${(m.episodes as unknown[]).length} episode(s)` : "",
                    ].filter(Boolean).join("    ·    ")
                    if (parts) para(parts, { size: 7.5, color: [107, 114, 128], indent: bodyIndent })
                } else if (m.savedFacts !== undefined) {
                    para(`${m.savedFacts ?? 0} fact(s), ${m.savedRules ?? 0} rule(s) saved · episode: ${m.episodeCaptured ? "yes" : "no"}`,
                        { size: 7.5, color: [107, 114, 128], indent: bodyIndent })
                }
                y += 1.5
                break
            }
            case "final":
                stepHead(KIND.final.label, KIND.final, indent, { title: step.event.node === "__cancelled__" ? "Run cancelled" : "Final summary", time: t(step.event) })
                if (step.event.content) para(step.event.content, { size: 9, color: [17, 24, 39], indent: bodyIndent })
                y += 1.5
                break
            case "error":
                stepHead(KIND.error.label, KIND.error, indent, { title: firstLine(step.event.content) || "Error", time: t(step.event) })
                if (step.event.content) para(step.event.content, { size: 8, font: "courier", color: [220, 38, 38], indent: bodyIndent })
                y += 1.5
                break
        }
    }

    for (const step of steps) renderStep(step, 0)

    // ── Footer on every page ────────────────────────────────────────────────
    const pages = doc.getNumberOfPages()
    for (let p = 1; p <= pages; p++) {
        doc.setPage(p)
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(156, 163, 175)
        const footer = `Nucleus Cloud Ops  ·  Page ${p} of ${pages}`
        doc.text(footer, PW / 2 - doc.getTextWidth(footer) / 2, PH - 6)
    }

    const filename = `agent-ops-run-${run.runId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.pdf`
    doc.save(filename)
}
