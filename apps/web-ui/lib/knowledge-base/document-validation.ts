/**
 * Validation for inline (authored) knowledge-base documents.
 * Pure — no I/O — so it is shared by the create route and the edit route.
 */

export const MAX_DOCUMENT_CHARS = 200_000;

export type DocumentValidationResult =
    | { ok: true; name: string; content: string }
    | { ok: false; error: string };

export function validateDocumentInput(input: { name?: string; content?: string }): DocumentValidationResult {
    const name = (input.name ?? '').trim();
    const content = (input.content ?? '').trim();

    if (!name) return { ok: false, error: 'name is required' };
    if (!content) return { ok: false, error: 'content is required' };
    if (content.length > MAX_DOCUMENT_CHARS) {
        return { ok: false, error: `Document is too large (max ${MAX_DOCUMENT_CHARS.toLocaleString()} characters)` };
    }
    return { ok: true, name, content };
}
