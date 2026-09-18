import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/Calendar.tsx', import.meta.url), 'utf8');
const scheduleCard = '<Card><div className="flex flex-wrap items-center gap-2">';
const sourceCard = '<Card><CardTitle>Calendars</CardTitle>';

describe('calendar page visual order', () => {
  it('renders the schedule controls and calendar before the source picker', () => {
    expect(page.indexOf(scheduleCard)).toBeGreaterThan(-1);
    expect(page.indexOf(sourceCard)).toBeGreaterThan(page.indexOf(scheduleCard));
  });

  it('keeps the whole source-selection card together below the rendered calendar', () => {
    const scheduleStart = page.indexOf(scheduleCard);
    const scheduleEnd = page.indexOf('    </Card>', scheduleStart);
    const sourceStart = page.indexOf(sourceCard);

    expect(scheduleEnd).toBeGreaterThan(scheduleStart);
    expect(sourceStart).toBeGreaterThan(scheduleEnd);
    expect(page.slice(sourceStart)).toContain('type="checkbox" checked={s.selected}');
    expect(page.slice(sourceStart)).toContain("s.writeDefault?'Write default':'Make default'");
    expect(page.slice(sourceStart)).not.toMatch(/(?:^|\s)(?:order-|sm:order-|md:order-|lg:order-)/);
  });

  it('uses the full practical member-content width for the calendar and picker', () => {
    expect(page).toContain('data-testid="calendar-page" className="w-full min-w-0 space-y-4"');
    expect(page).not.toMatch(/data-testid="calendar-page"[^>]+(?:max-w-|mx-auto)/);
  });
});
