import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchKbChunks } from '@/lib/knowledge-base/retrieval';

/**
 * Autonomous knowledge-base retrieval tool. The agent decides when to call it.
 * Scoping precedence: explicit knowledgeBaseIds arg → factory defaultKbIds →
 * tenant-wide (all KBs). tenantId is captured in the closure, never client-supplied.
 * Never throws — a retrieval failure returns a plain "no results" string so the
 * agent turn continues.
 */
export function createSearchKnowledgeBaseTool(tenantId: string, defaultKbIds?: string[]) {
    return tool(
        async ({ query, knowledgeBaseIds }: { query: string; knowledgeBaseIds?: string[] }) => {
            try {
                const ids = knowledgeBaseIds && knowledgeBaseIds.length > 0
                    ? knowledgeBaseIds
                    : (defaultKbIds && defaultKbIds.length > 0 ? defaultKbIds : undefined);
                const hits = await searchKbChunks({ tenantId, query, knowledgeBaseIds: ids, limit: 8 });
                if (hits.length === 0) {
                    return 'No relevant documents found in the knowledge base for that query.';
                }
                return hits
                    .map((h, i) => `[${i + 1}] ${h.documentName} (kb:${h.knowledgeBaseId}, score:${h.score.toFixed(2)})\n${h.textContent}`)
                    .join('\n\n');
            } catch (err) {
                console.warn(`[search_knowledge_base] failed (non-fatal): ${err instanceof Error ? err.message : err}`);
                return 'No relevant documents found (knowledge base search is temporarily unavailable).';
            }
        },
        {
            name: 'search_knowledge_base',
            description:
                'Search the organization\'s knowledge bases (uploaded docs, wikis, runbooks, synced repos) for information relevant to the user request. Call this whenever the question may be answered by internal/organizational documentation rather than live AWS state or general knowledge. Optionally pass knowledgeBaseIds to restrict the search; omit to search all available knowledge bases.',
            schema: z.object({
                query: z.string().describe('A focused natural-language search query describing what information you need.'),
                knowledgeBaseIds: z.array(z.string()).optional().describe('Optional list of knowledge base ids to restrict the search to. Omit to search across all of the tenant\'s knowledge bases.'),
            }),
        },
    );
}
