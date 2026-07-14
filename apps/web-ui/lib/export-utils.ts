/**
 * Shared helpers for Markdown/Blob export modules (skills, memory, and future
 * exporters). Pure helpers (fence/anchor/fileSafe/yamlScalar) are unit-tested
 * via their consumers; downloadBlob/downloadText are thin DOM wrappers.
 */

/**
 * Wrap content in a code fence that cannot be terminated early: the fence is
 * one backtick longer than the longest backtick run inside the content.
 */
export function fence(content: string, lang = "markdown"): string {
    const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const marker = "`".repeat(Math.max(3, longestRun + 1));
    return `${marker}${lang}\n${content}\n${marker}`;
}

/** GitHub-style heading anchor: lowercase, trim, spaces → hyphens, drop non-alnum. */
export function anchor(text: string): string {
    return text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

/** Trigger a client-side download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadText(content: string, filename: string, mimeType = "text/markdown;charset=utf-8"): void {
    downloadBlob(new Blob([content], { type: mimeType }), filename);
}

/** Lowercase, alnum+hyphen-only, trimmed; falls back to `fallback` (default "item") when empty. */
export function fileSafe(text: string, fallback = "item"): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

/**
 * Emit a YAML scalar safe to embed in frontmatter. Single-line values use
 * double-quoted form (backslash + double-quote escaped); multi-line values use
 * a block scalar so newlines are preserved verbatim.
 */
export function yamlScalar(value: string): string {
    const v = value ?? "";
    if (v.includes("\n")) {
        const indented = v.split("\n").map((l) => `  ${l}`).join("\n");
        return `|-\n${indented}`;
    }
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}