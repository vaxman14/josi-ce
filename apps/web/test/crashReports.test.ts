import { beforeEach, describe, expect, it } from 'vitest';
import { forgetBrowserCrashes, reportBrowserCrash, reportToText, textToReport } from '../src/lib/crashReports.js';

beforeEach(() => forgetBrowserCrashes());

describe('the browser reports its own crashes', () => {
  it('says each distinct failure once, and no more than three a visit', () => {
    const sent: string[] = [];
    const post = async (message: string) => { sent.push(message); };
    expect(reportBrowserCrash(new TypeError('x is undefined'), post)).toBe(true);
    expect(reportBrowserCrash(new TypeError('x is undefined'), post)).toBe(false);
    expect(reportBrowserCrash(new Error('two'), post)).toBe(true);
    expect(reportBrowserCrash('three', post)).toBe(true);
    expect(reportBrowserCrash(new Error('four'), post)).toBe(false);
    expect(sent).toEqual(['TypeError: x is undefined', 'Error: two', 'three']);
  });

  it('never lets a failed report become a second crash', async () => {
    expect(reportBrowserCrash(new Error('boom'), async () => { throw new Error('offline'); })).toBe(true);
    await Promise.resolve();
  });

  it('sends the stack of an error and nothing about the page or what was typed', () => {
    const seen: Array<[string, string]> = [];
    reportBrowserCrash(Object.assign(new Error('bad'), { stack: 'Error: bad\n    at f (a.js:1:2)' }), async (message, stack) => { seen.push([message, stack]); });
    expect(seen).toEqual([['Error: bad', 'Error: bad\n    at f (a.js:1:2)']]);
  });
});

describe('editing a report as text', () => {
  it('round-trips, and refuses what is no longer a report', () => {
    const report = { type: 'crash', error: 'boom', last_log_lines: ['a', 'b'] };
    const text = reportToText(report);
    expect(text).toContain('\n  "error": "boom"');
    expect(textToReport(text)).toEqual({ ok: true, report });
    expect(textToReport('{ not json')).toMatchObject({ ok: false });
    expect(textToReport('[1, 2]')).toMatchObject({ ok: false, message: 'The report must stay a JSON object.' });
    expect(textToReport('"text"')).toMatchObject({ ok: false });
  });
});
