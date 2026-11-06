import type { Response } from 'express';

const esc = (text: string): string => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** A plain page saying what happened, for flows that end in a browser. */
export function notice(res: Response, status: number, title: string, text: string, link?: string): void {
  res.status(status).type('html').set('cache-control', 'no-store').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main class="narrow"><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a href="${esc(link)}">Back to Josi</a></p>` : ''}</main></body></html>`);
}
