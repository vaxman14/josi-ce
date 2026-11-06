import { describe, expect, it } from 'vitest';
import { presentTurnActivity } from '../src/http/turnActivity.js';

describe('presentTurnActivity', () => {
  it('names what a turn read without its contents', () => {
    const activity = presentTurnActivity([
      { tool: 'search_email', result: { ok: true, emails: [{ email_id: 'google:1', from: 'Ana <ana@example.com>', to: 'me', subject: 'Invoice', date: '2026-11-03', snippet: 'SECRET SNIPPET' }] } },
      { tool: 'read_email', result: { ok: true, email: { email_id: 'google:1', from: 'Ana <ana@example.com>', subject: 'Invoice', date: '2026-11-03', body: 'SECRET BODY' } } },
      { tool: 'query_calendar', result: { ok: true, events: [{ event_id: 'e', provider_event_id: 'p', title: 'Dentist', start: '2026-11-05T17:00:00Z', calendar_name: 'Primary', attendees: ['x@example.com'] }] } },
      { tool: 'search_contacts', result: { ok: true, contacts: [{ name: 'Mia', email: 'mia@example.com', phone: '555' }] } },
      { tool: 'search_documents', result: { ok: true, hits: [{ citation: 'plan.docx, page 2', snippet: 'SECRET TEXT', document_id: 'd' }] } },
    ]);
    expect(activity.tools).toEqual(['search_email', 'read_email', 'query_calendar', 'search_contacts', 'search_documents']);
    expect(activity.sources.map((s) => [s.kind, s.title, s.detail])).toEqual([
      ['email', 'Invoice', 'Ana <ana@example.com>'], ['email', 'Invoice', 'Ana <ana@example.com>'],
      ['event', 'Dentist', 'Primary'], ['contact', 'Mia', 'mia@example.com · 555'], ['document', 'plan.docx, page 2', ''],
    ]);
    expect(JSON.stringify(activity)).not.toContain('SECRET');
    expect(JSON.stringify(activity)).not.toContain('provider_event_id');
  });

  it('leaves out failed tools and tolerates anything else', () => {
    expect(presentTurnActivity([{ tool: 'search_email', result: { ok: false, error: 'x' } }, null, 'nope', { result: {} }])).toEqual({ tools: [], sources: [] });
    expect(presentTurnActivity(null)).toEqual({ tools: [], sources: [] });
  });

  it('keeps the last sources when a turn read a lot', () => {
    const emails = Array.from({ length: 30 }, (_, i) => ({ subject: `Mail ${i}` }));
    const { sources } = presentTurnActivity([{ tool: 'search_email', result: { ok: true, emails } }]);
    expect(sources).toHaveLength(12);
    expect(sources[11]?.title).toBe('Mail 29');
  });
});
