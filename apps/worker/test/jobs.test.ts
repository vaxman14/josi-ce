import { describe, expect, it } from 'vitest';
import { calendarEventUrl } from '../src/jobs.js';

describe('calendar write target', () => {
  it('writes Google events to the selected calendar instead of primary', () => {
    expect(calendarEventUrl('google', 'vaxman kids@example.test')).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/vaxman%20kids%40example.test/events',
    );
  });

  it('keeps the selected Microsoft calendar and event for edits', () => {
    expect(calendarEventUrl('microsoft', 'calendar/id', 'event/id')).toBe(
      'https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events/event%2Fid',
    );
  });
});
