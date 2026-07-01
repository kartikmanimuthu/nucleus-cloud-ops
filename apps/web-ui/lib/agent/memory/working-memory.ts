import type { BaseMessage } from '@langchain/core/messages';
import { getRecentMessages } from '../agent-shared';
import type { Scratchpad, WorkingMemory } from './types';

// Working-memory configuration. Read process.env directly (not the typed `env`
// object) so Vitest can mutate values per-test — env.ts skips validation under
// NODE_ENV==='test' but caches at import time.
export function workingMemoryEnabled(): boolean {
    const v = process.env.WORKING_MEMORY_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export function tokenBudget(): number {
    const n = Number(process.env.WORKING_MEMORY_TOKEN_BUDGET);
    return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function keepRecent(): number {
    const n = Number(process.env.WORKING_MEMORY_KEEP_RECENT);
    return Number.isFinite(n) && n > 0 ? n : 8;
}

export function emptyScratchpad(): Scratchpad {
    return { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] };
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function messageText(m: BaseMessage): string {
    return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

export function estimateMessagesTokens(messages: BaseMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
}

export function compressToolOutput(content: string, maxChars = 2000): string {
    if (content.length <= maxChars) return content;
    const half = Math.floor(maxChars / 2);
    const head = content.slice(0, half);
    const tail = content.slice(content.length - half);
    return `${head}\n… [${content.length - maxChars} chars elided] …\n${tail}`;
}

// Pick the most-recent messages that fit `budget` tokens, always keeping at least
// `keep` of them, then run getRecentMessages() to preserve tool_call/tool_result
// pairing and drop empties (Bedrock adjacency rules).
export function selectWindow(messages: BaseMessage[], budget: number, keep: number): BaseMessage[] {
    if (messages.length === 0) return [];
    let count = Math.min(keep, messages.length);
    let used = estimateMessagesTokens(messages.slice(messages.length - count));
    for (let i = messages.length - count - 1; i >= 0; i--) {
        const t = estimateTokens(messageText(messages[i]));
        if (used + t > budget) break;
        used += t;
        count++;
    }
    const slice = messages.slice(messages.length - count);
    return getRecentMessages(slice, slice.length);
}

export function buildWorkingMemorySection(wm: WorkingMemory | null): string {
    if (!wm) return '';
    const s = wm.scratchpad ?? emptyScratchpad();
    const list = (label: string, items: string[]) =>
        items && items.length ? `\n**${label}:**\n${items.map((i) => `- ${i}`).join('\n')}` : '';
    const body = [
        wm.runningSummary ? `\n${wm.runningSummary}` : '',
        list('Open goals', s.openGoals),
        list('Key findings', s.keyFindings),
        list('Resource IDs', s.resourceIds),
        list('Pending steps', s.pendingSteps),
    ].join('');
    if (!body.trim()) return '';
    return `\n## Working Memory\nA compacted record of this long-running session so far:${body}\n`;
}
