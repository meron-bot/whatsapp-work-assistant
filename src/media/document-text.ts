/**
 * Extracts plain text from a document buffer (PDF or Word .docx). Best-effort:
 * returns null when the type is unsupported or extraction fails (encrypted /
 * corrupt / image-only), so the caller degrades to "document received" instead
 * of throwing. This is what lets the planner act on a document's CONTENT rather
 * than just its filename.
 */

// pdf-parse and mammoth ship as CommonJS with loose types; require keeps the
// signatures explicit and avoids default-interop friction.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse') as (data: Buffer) => Promise<{ text: string }>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth') as {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
};

/** Cap extracted text so a huge document can't blow up the planner prompt. */
export const MAX_DOCUMENT_CHARS = 8000;

function isPdf(mimeType: string, filename: string | null): boolean {
  return mimeType.includes('pdf') || (filename ?? '').toLowerCase().endsWith('.pdf');
}

function isDocx(mimeType: string, filename: string | null): boolean {
  return (
    mimeType.includes('officedocument.wordprocessingml') ||
    (filename ?? '').toLowerCase().endsWith('.docx')
  );
}

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  filename: string | null,
): Promise<string | null> {
  try {
    let text: string | null = null;
    if (isPdf(mimeType, filename)) {
      text = (await pdfParse(buffer)).text;
    } else if (isDocx(mimeType, filename)) {
      text = (await mammoth.extractRawText({ buffer })).value;
    }
    const trimmed = (text ?? '').replace(/[ \t]+\n/g, '\n').trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_DOCUMENT_CHARS
      ? `${trimmed.slice(0, MAX_DOCUMENT_CHARS)}\n…(truncated)`
      : trimmed;
  } catch {
    return null; // unreadable / encrypted / corrupt — degrade gracefully
  }
}
