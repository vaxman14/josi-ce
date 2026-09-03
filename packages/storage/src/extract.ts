// Turning a file's bytes into searchable text — for the formats where that is
// honest to do without a parser.
//
// CE ships no PDF or Office parser in this round. The text-bearing plain
// formats (txt, md, csv, json, html…) are decoded here; everything else that
// passed the gates is recorded as `unsupported_type`, whose explanation to the
// owner already reads "Josi cannot read this kind of file yet". A file counted
// and honestly skipped is the house rule; a parser guessed at is not.
//
// Nothing in this module touches the network or the providers. Bytes in,
// segments out, and the decision of what to DO with a refusal stays with the
// caller — which is what makes the whole matrix testable without a database.
import { appendEvent, type Db } from '@josi-ce/core';

export interface ExtractedSegment {
  locatorKind: 'none' | 'line' | 'heading';
  locator: string;
  content: string;
}

/** Formats read as text directly. Deliberately a list of what IS plain text
 * rather than a guess from the bytes: a `.docx` that happens to decode as
 * UTF-8 garbage must not be indexed as garbage. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm',
]);

/** How much text one document may contribute to the index. Generous for
 * documents, small next to the database — and a ceiling, not a target. */
export const MAX_EXTRACT_CHARS = 500_000;

export function isExtractableExtension(extension: string): boolean {
  return TEXT_EXTENSIONS.has(extension.toLowerCase());
}

/** Markup stripped, entities the bare minimum, structure ignored. Search wants
 * the words; anything smarter belongs to a real parser in a later round. */
function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text of one file, or null when this format is not one Josi can read yet.
 *
 * Null is a STATEMENT, not a failure: the caller records `unsupported_type`
 * and the owner sees the honest sentence. A decode that produces control-byte
 * soup (a mislabelled binary) also comes back null rather than polluting the
 * index with noise.
 */
export function extractSegments(
  args: { extension: string; bytes: Buffer },
): ExtractedSegment[] | null {
  const extension = args.extension.toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return null;

  let text = args.bytes.toString('utf8');
  // A replacement character every few bytes means this was never text.
  const junk = (text.slice(0, 4000).match(/\uFFFD/g) ?? []).length;
  if (junk > 40) return null;

  if (extension === 'html' || extension === 'htm') text = stripHtml(text);
  text = text.replace(/\u0000/g, '').trim();
  if (!text) return null;
  if (text.length > MAX_EXTRACT_CHARS) text = text.slice(0, MAX_EXTRACT_CHARS);

  return [{ locatorKind: 'none', locator: '', content: text }];
}

/** Write what was extracted, replacing whatever was there.
 *
 * Replacement, not append: an edited file's old text must not stay searchable
 * next to its new text. The document becomes `indexed`, which is what opens
 * the search gate for it.
 */
export async function storeExtraction(
  db: Db,
  args: { documentId: string; ownerUserId: string; segments: ExtractedSegment[] },
): Promise<void> {
  const content = args.segments.map((s) => s.content).join('\n\n');
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await db.query(
    `insert into document_text (document_id, owner_user_id, content, locator_kind, char_count)
     values ($1, $2, $3, 'none', $4)`,
    [args.documentId, args.ownerUserId, content, content.length],
  );
  for (let i = 0; i < args.segments.length; i++) {
    const segment = args.segments[i];
    await db.query(
      `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
       values ($1, $2, $3, $4, $5, $6)`,
      [args.documentId, args.ownerUserId, i, segment.locatorKind, segment.locator, segment.content],
    );
  }
  await db.query(
    `update documents set state = 'indexed', skip_reason = null where id = $1`,
    [args.documentId],
  );
}

/** M74: a file passed over gets a reason, its derived text goes with it, and
 * the audit record carries the reason — never the filename. The same shape as
 * ingest's private markSkipped, exported here for the steps AFTER the gates:
 * a download that failed, a format Josi cannot read, bytes that turned out
 * encrypted once fetched. */
export async function skipDocument(
  db: Db,
  args: {
    documentId: string;
    ownerUserId: string;
    reason: 'encrypted' | 'too_large' | 'unreadable' | 'unsupported_type';
  },
): Promise<void> {
  await db.query(
    `update documents set state = 'skipped', skip_reason = $2 where id = $1`,
    [args.documentId, args.reason],
  );
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'system',
    kind: 'storage.file_skipped',
    subjectType: 'document',
    subjectId: args.documentId,
    payload: { reason: args.reason },
  });
}
