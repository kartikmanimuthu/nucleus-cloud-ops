/** UI bucket derived from an AgentMemory namespace's first path segment. */
export type MemoryCategory = 'infra' | 'user' | 'patterns' | 'errors' | 'other';

/** The four agent-written namespace prefixes, in the order the UI shows them. */
export const KNOWN_CATEGORIES: MemoryCategory[] = ['infra', 'user', 'patterns', 'errors'];

/**
 * Memories store `namespace` as a slash-joined string (e.g. "infra/<account-id>",
 * "user/preferences"). The category is the first segment, lower-cased; anything
 * outside the known set falls into "other".
 */
export function categoryFromNamespace(namespace: string): MemoryCategory {
    const first = (namespace || '').split('/')[0]?.toLowerCase() ?? '';
    return (KNOWN_CATEGORIES as string[]).includes(first)
        ? (first as MemoryCategory)
        : 'other';
}
