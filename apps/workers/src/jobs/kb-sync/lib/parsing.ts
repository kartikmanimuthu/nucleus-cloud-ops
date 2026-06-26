// ---------------------------------------------------------------------------
// Content parsing & file type detection
// ---------------------------------------------------------------------------

export const SUPPORTED_EXT = new Set(['pdf', 'md', 'txt', 'json', 'csv', 'yaml', 'yml']);

export function isSupportedKey(key: string): boolean {
  return SUPPORTED_EXT.has(key.split('.').pop()?.toLowerCase() ?? '');
}

export function getMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'application/pdf' : ext === 'json' ? 'application/json' : 'text/plain';
}

export async function parseContent(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    // Dynamic import to avoid bundling issues
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  return buffer.toString('utf-8');
}
