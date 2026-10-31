// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { useFormat, type Format } from './use-format';

function Shown({ what }: { what: (format: Format) => string }) {
  return <p>{what(useFormat())}</p>;
}

/** What somebody reading `locale` sees. The provider is given a time zone of its own, as the server gives it one. */
function shown(what: (format: Format) => string, locale: 'en' | 'pl' = 'en'): string {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="Asia/Tokyo">
      <Shown what={what} />
    </NextIntlClientProvider>,
  );
  // A language may put a space that does not break between a number and its unit.
  const text = (screen.getByRole('paragraph').textContent ?? '').replace(/[   ]/g, ' ');
  unmount();
  return text;
}

describe('dates, numbers and units, as the language of the application writes them', () => {
  const machineZone = process.env.TZ;

  afterEach(() => {
    process.env.TZ = machineZone;
  });

  it('writes a calendar day as that day, whatever the time zone of the reader or of the server', () => {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = zone;

      expect(shown((f) => f.day('2026-01-05'))).toBe('Mon, Jan 5');
      expect(shown((f) => f.date('2026-01-05'))).toBe('Jan 5, 2026');
      expect(shown((f) => f.dayShort('2026-01-05'))).toBe('Jan 5');
      expect(shown((f) => f.dates('2026-01-05', '2026-01-11'))).toBe('Jan 5 – 11, 2026');
    }
    expect(shown((f) => f.day('2026-01-05'), 'pl')).toBe('pon., 5 sty');
    expect(shown((f) => f.date('2026-01-05'), 'pl')).toBe('5 sty 2026');
    expect(shown((f) => f.dates('2026-01-05', '2026-01-11'), 'pl')).toBe('5–11 sty 2026');
  });

  it('names the month and the weekday of a calendar day, whatever the time zone', () => {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = zone;

      expect(shown((f) => f.month('2026-01-01'))).toBe('January 2026');
      expect(shown((f) => f.weekday('2026-01-05'))).toBe('Mon');
    }
    expect(shown((f) => f.month('2026-01-31'), 'pl')).toBe('styczeń 2026');
    expect(shown((f) => f.weekday('2026-01-05'), 'pl')).toBe('pon.');
    expect(shown((f) => f.weekday('2026-01-05', 'long'))).toBe('Monday');
    expect(shown((f) => f.weekday('2026-01-05', 'long'), 'pl')).toBe('poniedziałek');
  });

  it("writes a moment by the clock of the reader, not by the server's", () => {
    const moment = '2026-01-05T23:30:00.000Z';

    process.env.TZ = 'Europe/Warsaw';
    expect(shown((f) => f.moment(moment), 'pl')).toBe('6 sty 2026, 00:30');
    expect(shown((f) => f.dayOf(moment), 'pl')).toBe('6 sty 2026');

    process.env.TZ = 'America/New_York';
    expect(shown((f) => f.moment(moment))).toBe('Jan 5, 2026, 6:30 PM');
    expect(shown((f) => f.dayOf(moment))).toBe('Jan 5, 2026');
  });

  it('writes a number with the decimal sign of the language, and nothing between its thousands', () => {
    expect(shown((f) => f.number(2150))).toBe('2150');
    expect(shown((f) => f.number(2150), 'pl')).toBe('2150');
    expect(shown((f) => f.number(12150), 'pl')).toBe('12150');
    expect(shown((f) => f.number(1234567.5, 1))).toBe('1234567.5');
    expect(shown((f) => f.fixed(12150.5, 2), 'pl')).toBe('12150,50');
    expect(shown((f) => f.signed(12150))).toBe('+12150');
    expect(shown((f) => f.unit(12150, 'gram'), 'pl')).toBe('12150 g');
    expect(shown((f) => f.percent(12.5))).toBe('1250%');
    expect(shown((f) => f.number(79.46, 1))).toBe('79.5');
    expect(shown((f) => f.number(79.46, 1), 'pl')).toBe('79,5');
    expect(shown((f) => f.number(80, 1), 'pl')).toBe('80');
    expect(shown((f) => f.fixed(1.2, 2), 'pl')).toBe('1,20');
    expect(shown((f) => `${f.signed(120)} ${f.signed(-80)} ${f.signed(0)}`)).toBe('+120 -80 +0');
    expect(shown((f) => f.percent(0.42), 'pl')).toBe('42%');
  });

  it('writes a number with its unit', () => {
    expect(shown((f) => f.unit(79.5, 'kilogram', 1))).toBe('79.5 kg');
    expect(shown((f) => f.unit(79.5, 'kilogram', 1), 'pl')).toBe('79,5 kg');
    expect(shown((f) => f.unit(215, 'gram'), 'pl')).toBe('215 g');
    expect(shown((f) => f.unit(15, 'minute'))).toBe('15 min');
    expect(shown((f) => f.unit(12.34, 'kilobyte', 1), 'pl')).toBe('12,3 kB');
  });

  it('names several things one after another the way the language joins them', () => {
    expect(shown((f) => f.list(['rice', 'oats', 'tofu']))).toBe('rice, oats, and tofu');
    expect(shown((f) => f.list(['ryż', 'owies', 'tofu']), 'pl')).toBe('ryż, owies i tofu');
    expect(shown((f) => f.list(['rice', 'oats']))).toBe('rice and oats');
    expect(shown((f) => f.list(['rice']))).toBe('rice');
  });
});
