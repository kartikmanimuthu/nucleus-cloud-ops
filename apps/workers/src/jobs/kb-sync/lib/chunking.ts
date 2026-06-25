import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Chunking constants
// ---------------------------------------------------------------------------

export const CHUNK_SIZE = 1500;
export const CHUNK_OVERLAP = 200;

// ---------------------------------------------------------------------------
// Chunk type
// ---------------------------------------------------------------------------

export interface Chunk {
  text: string;
  index: number;
  total: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Chunking functions
// ---------------------------------------------------------------------------

export function chunkText(text: string, docName: string): Chunk[] {
  const seps = ['\n\n', '\n', '. ', ' '];
  const raw = recursiveSplit(text, CHUNK_SIZE, seps);
  const total = raw.length;
  return raw.map((t, i) => ({
    text: `Document: ${docName} | Chunk ${i + 1}/${total}\n\n${t}`,
    index: i,
    total,
    contentHash: createHash('sha256').update(t).digest('hex').slice(0, 16),
  }));
}

export function recursiveSplit(text: string, max: number, seps: string[]): string[] {
  if (text.length <= max) return text.trim() ? [text] : [];
  const sep = seps.find((s) => text.includes(s));
  if (!sep) return forceChunk(text, max);
  const parts: string[] = [];
  let buf = '';
  for (const part of text.split(sep)) {
    const candidate = buf ? buf + sep + part : part;
    if (candidate.length <= max) {
      buf = candidate;
    } else {
      if (buf) parts.push(buf);
      buf = part.length > max ? '' : part;
      if (part.length > max) parts.push(...recursiveSplit(part, max, seps.slice(1)));
    }
  }
  if (buf) parts.push(buf);
  // Add overlap
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = i > 0 ? parts[i - 1].slice(-CHUNK_OVERLAP) : '';
    result.push((prev + parts[i]).slice(0, max));
  }
  return result.filter((s) => s.trim());
}

export function forceChunk(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}
