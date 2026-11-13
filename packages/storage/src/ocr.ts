// Reading the text in a picture or a scanned page, on this server.
//
// For a model that cannot see images. Nothing here describes a picture: it
// returns the words printed in it, page by page, with how sure the reader was.
// The engine is Tesseract compiled to WebAssembly, with its English data
// shipped inside the package, so it runs on the CPU, inside Josi's own
// process, with no download and no network. A scanned PDF is drawn to images
// page by page first (the PDF library's own renderer) and read the same way.
//
// One job at a time: recognition holds roughly 150 to 250 MB while it runs,
// and two people attaching scans together should queue, not double that.
import { PDFParse } from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const OCR_LANGUAGE_PATH = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');

export interface OcrPage {
  page: number;
  text: string;
  /** 0 to 100, the reader's own mean confidence for the page. */
  confidence: number;
  /** True when the page is likely misread: low confidence, or almost nothing found. */
  poor: boolean;
}

export interface OcrResult {
  pages: OcrPage[];
  /** Pages in the document; more than `pages.length` when only the first ones were read. */
  totalPages: number;
}

/** Below this the words are more guess than reading. */
export const OCR_POOR_CONFIDENCE = 60;
/** How many pages of one scanned document are read. Each takes a few seconds of CPU. */
export const OCR_MAX_PAGES = 12;

let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function recognize(images: Array<{ page: number; bytes: Uint8Array }>): Promise<OcrPage[]> {
  const worker = await createWorker('eng', undefined, { langPath: OCR_LANGUAGE_PATH, cacheMethod: 'none' });
  try {
    const pages: OcrPage[] = [];
    for (const image of images) {
      const input = Buffer.from(image.bytes) as unknown as Parameters<typeof worker.recognize>[0];
      const { data } = await worker.recognize(input);
      const text = (data.text ?? '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const confidence = Math.max(0, Math.min(100, Math.round(data.confidence ?? 0)));
      pages.push({ page: image.page, text, confidence, poor: confidence < OCR_POOR_CONFIDENCE || text.replace(/\s/g, '').length < 12 });
    }
    return pages;
  } finally { await worker.terminate(); }
}

/** The text in one picture. */
export function ocrImage(bytes: Buffer): Promise<OcrResult> {
  return oneAtATime(async () => ({ pages: await recognize([{ page: 1, bytes }]), totalPages: 1 }));
}

/** Whether a PDF's own text is too thin to be the document: a scan carries
 * pictures of pages and at most a few stray characters. */
export function looksScanned(extractedText: string | null | undefined, pages = 1): boolean {
  return (extractedText ?? '').replace(/\s/g, '').length < 40 * Math.max(1, Math.min(pages, 5));
}

/** The text on the pages of a scanned PDF, read from pictures of them. */
export function ocrPdf(bytes: Buffer, opts: { maxPages?: number } = {}): Promise<OcrResult> {
  const maxPages = opts.maxPages ?? OCR_MAX_PAGES;
  return oneAtATime(async () => {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      // About 150 dots per inch for a letter page: enough for body text, and a
      // third of the memory of drawing at print resolution.
      const shots = await parser.getScreenshot({ first: maxPages, desiredWidth: 1400, imageBuffer: true, imageDataUrl: false });
      const pages = await recognize(shots.pages.map((p) => ({ page: p.pageNumber, bytes: p.data })));
      return { pages, totalPages: shots.total };
    } finally { await parser.destroy(); }
  });
}

/** What the model is handed: the words, the page they were on, and a plain
 * flag on any page that probably was not read correctly. */
export function formatOcr(filename: string, result: OcrResult): string {
  const pdf = result.totalPages > 1 || /\.pdf$/i.test(filename);
  const readable = result.pages.filter((p) => p.text);
  if (!readable.length) {
    return `Attached ${pdf ? 'scanned document' : 'picture'} ${filename}: Josi tried to read its text (OCR) and found none. `
      + 'You cannot see it, so say that no text could be read and do not guess what it shows.';
  }
  const head = `Text read by OCR from the attached ${pdf ? 'scanned document' : 'picture'} ${filename}. `
    + 'You were NOT shown the picture itself, only these words, so answer from them and do not describe how anything looks. '
    + 'OCR makes mistakes: quote exactly, and where a page is marked POOR tell the person that part may be misread.';
  const body = result.pages.map((p) => `[page ${p.page}, ${p.poor ? `POOR reading, confidence ${p.confidence}%` : `confidence ${p.confidence}%`}]\n${p.text || '(no text found on this page)'}`).join('\n\n');
  const rest = result.totalPages > result.pages.length
    ? `\n\n[Only pages 1 to ${result.pages.length} of ${result.totalPages} were read. Say so, and offer to read a later part if the person sends those pages.]` : '';
  return `${head}\n\n${body}${rest}`;
}
