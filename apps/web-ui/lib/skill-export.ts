/**
 * Skill → Markdown export.
 *
 * Mirrors the pure-core + Blob-download split used by lib/agent-ops/export-markdown.ts
 * and lib/chat-export.ts: buildSkillMarkdown()/buildAllSkillsMarkdown() are pure
 * (unit-tested); exportSkillToMarkdown()/exportAllSkillsToMarkdown() wrap them in a
 * Blob download. Skill `content` is fenced so triple-backtick runs inside it cannot
 * terminate the fence early.
 */

import type { SkillDTO } from "@/lib/client-skill-service";
import { fence, anchor, downloadBlob, downloadText, fileSafe, yamlScalar } from "@/lib/export-utils";

/** Build the Markdown document for a single skill. Pure. */
export function buildSkillMarkdown(skill: SkillDTO): string {
    const content = skill.content ?? "";
    const lines: string[] = [
        `# ${skill.name}`,
        "",
        `> ${skill.description}`,
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Slug | \`${skill.id}\` |`,
        `| Tier | ${skill.tier} |`,
        `| Source | ${skill.source} |`,
        `| Status | ${skill.isEnabled ? "Enabled" : "Disabled"} |`,
        `| Created | ${skill.createdAt} |`,
        `| Updated | ${skill.updatedAt} |`,
        `| Created by | ${skill.createdBy ?? "—"} |`,
        "",
        "## Content",
        "",
        fence(content),
        "",
    ];
    return lines.join("\n");
}

/** Build the Markdown document for a collection of skills (table of contents + each skill). Pure. */
export function buildAllSkillsMarkdown(skills: SkillDTO[]): string {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    const header: string[] = [
        "# Skills export",
        "",
        `Exported ${sorted.length} skill(s).`,
        "",
    ];
    if (sorted.length === 0) {
        header.push("_No skills to export._", "");
        return header.join("\n");
    }
    header.push("## Table of contents", "");
    for (const s of sorted) {
        header.push(`- [${s.name}](#${anchor(s.name)})`);
    }
    header.push("", "---", "");
    const body = sorted.map((s) => `${buildSkillMarkdown(s)}\n---\n`);
    return `${header.join("\n")}\n${body.join("\n")}`;
}

/**
 * Build a portable SKILL.md document for a skill: YAML frontmatter (name,
 * description, tier, enabled) followed by the skill `content` as the body.
 * This is the Anthropic Agent Skills convention — re-importable by other AI tools
 * that consume SKILL.md files. Pure.
 */
export function buildSkillFile(skill: SkillDTO): string {
    const frontmatter = [
        "---",
        `name: ${yamlScalar(skill.name)}`,
        `description: ${yamlScalar(skill.description)}`,
        `tier: ${yamlScalar(skill.tier)}`,
        `enabled: ${skill.isEnabled ? "true" : "false"}`,
        "---",
        "",
    ].join("\n");
    return `${frontmatter}\n${skill.content ?? ""}\n`;
}

/** Download a single skill as a portable SKILL.md-formatted `.md` file. Impure (DOM + Blob). */
export function exportSkillToFile(skill: SkillDTO): void {
    downloadText(buildSkillFile(skill), `${skill.id || fileSafe(skill.name)}.md`);
}

/** Download a single skill as a `.md` file (human-readable report). Impure (DOM + Blob). */
export function exportSkillToMarkdown(skill: SkillDTO): void {
    const markdown = buildSkillMarkdown(skill);
    downloadText(markdown, `skill-${fileSafe(skill.name)}.md`);
}

/** Download all skills as a single `.md` file (human-readable report). Impure (DOM + Blob). */
export function exportAllSkillsToMarkdown(skills: SkillDTO[]): void {
    const markdown = buildAllSkillsMarkdown(skills);
    downloadText(markdown, `skills-export-${new Date().toISOString().slice(0, 10)}.md`);
}

/**
 * Download all skills as a `.zip` of portable SKILL.md files, one per skill at
 * `skills/<slug>/SKILL.md` (the Claude Code skill layout). jszip is dynamically
 * imported so it stays out of the main bundle for users who never export. Impure
 * (DOM + Blob + dynamic import).
 */
export async function exportAllSkillsToZip(skills: SkillDTO[]): Promise<void> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const root = zip.folder("skills");
    if (!root) throw new Error("Failed to create skills folder in zip");
    for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
        root.file(`${s.id}/SKILL.md`, buildSkillFile(s));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `skills-export-${new Date().toISOString().slice(0, 10)}.zip`);
}