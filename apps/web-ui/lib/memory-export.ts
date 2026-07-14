/**
 * Memory → Markdown export.
 *
 * Mirrors lib/skill-export.ts: buildMemoryMarkdown()/buildAllMemoriesMarkdown()
 * are the pure cores of the human-readable "report" export;
 * buildMemoryFile() is the pure core of the portable frontmatter export (for
 * reuse with other AI tools). export*ToMarkdown()/exportAllMemoriesToZip() wrap
 * them in Blob/zip downloads. Embeddings are never in the MemoryRow DTO, so
 * there is nothing to strip.
 */

import type { MemoryRow } from "@/lib/queries/agent-memories";
import type { MemoryKind } from "@/lib/agent/memory/types";
// `fence` is intentionally NOT imported: memory bodies are prose, never fenced.
// The other helpers come online in later tasks (anchor in Task 3, yamlScalar in
// Task 4, the download/fileSafe trio in Task 5). Unused-import warnings are
// non-failing (noUnusedLocals=false; lint no-unused-vars is a warning), so
// importing them all up front is safe and avoids repeated edits to this line.
import { anchor, downloadBlob, downloadText, fileSafe, yamlScalar } from "@/lib/export-utils";

const KIND_ORDER: MemoryKind[] = ["SEMANTIC", "EPISODIC", "PROCEDURAL"];

/** Read a string field from the raw `value` JSON, or "—" if absent/empty. */
function field(value: Record<string, unknown>, key: string): string {
    const v = value?.[key];
    return typeof v === "string" && v.length ? v : "—";
}

/**
 * Render the kind-specific `value` fields as labeled Markdown prose. Shared by
 * the report and portable builders so they never drift. Pure.
 */
function renderValueBody(memory: MemoryRow): string {
    const v = memory.value ?? {};
    switch (memory.kind) {
        case "SEMANTIC":
            return [
                `**Fact:** ${field(v, "fact")}`,
                `**Source:** ${field(v, "source")}`,
                `**Confidence:** ${memory.confidence ?? "—"}`,
                "",
            ].join("\n");
        case "EPISODIC":
            return [
                `**Context:** ${field(v, "context")}`,
                `**Reasoning:** ${field(v, "reasoning")}`,
                `**Action:** ${field(v, "action")}`,
                `**Outcome:** ${field(v, "outcome")}`,
                "",
            ].join("\n");
        case "PROCEDURAL":
            return [
                `**Instruction:** ${field(v, "instruction")}`,
                `**Trigger:** ${field(v, "trigger")}`,
                `**Evidence:** ${field(v, "evidence")}`,
                `**Confidence:** ${memory.confidence ?? "—"}`,
                "",
            ].join("\n");
        default:
            return "";
    }
}

/** Build the human-readable Markdown report for a single memory. Pure. */
export function buildMemoryMarkdown(memory: MemoryRow): string {
    const lines: string[] = [
        `# ${memory.key}`,
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Kind | ${memory.kind} |`,
        `| Namespace | ${memory.namespace} |`,
        `| Category | ${memory.category} |`,
        `| Confidence | ${memory.confidence ?? "—"} |`,
        `| Source | ${memory.source ?? "—"} |`,
        `| Created | ${memory.createdAt} |`,
        `| Updated | ${memory.updatedAt} |`,
        `| Superseded by | ${memory.supersededById ?? "—"} |`,
        "",
        renderValueBody(memory),
    ];
    return lines.join("\n");
}

/** Build the combined human-readable Markdown report for all memories (TOC + each memory). Pure. */
export function buildAllMemoriesMarkdown(memories: MemoryRow[]): string {
    const header: string[] = [
        "# Memory export",
        "",
        `Exported ${memories.length} memory record(s).`,
        "",
    ];
    if (memories.length === 0) {
        header.push("_No memories to export._", "");
        return header.join("\n");
    }
    const byKind = new Map<MemoryKind, MemoryRow[]>();
    for (const m of memories) {
        const arr = byKind.get(m.kind) ?? [];
        arr.push(m);
        byKind.set(m.kind, arr);
    }
    for (const arr of byKind.values()) {
        arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    header.push("## Table of contents", "");
    for (const kind of KIND_ORDER) {
        const arr = byKind.get(kind);
        if (!arr || arr.length === 0) continue;
        header.push(`### ${kind}`, "");
        for (const m of arr) header.push(`- [${m.key}](#${anchor(m.key)})`);
        header.push("");
    }
    header.push("---", "");
    const body: string[] = [];
    for (const kind of KIND_ORDER) {
        const arr = byKind.get(kind);
        if (!arr || arr.length === 0) continue;
        for (const m of arr) {
            body.push(buildMemoryMarkdown(m), "---", "");
        }
    }
    return `${header.join("\n")}\n${body.join("\n")}`;
}
