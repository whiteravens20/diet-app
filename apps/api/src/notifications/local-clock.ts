// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** A moment as the clock of a time zone shows it: its calendar day, hour and minute. */
export interface LocalClock {
  day: string;
  hour: number;
  minute: number;
}

/** What the clock of `zone` (as IANA names it) shows at `now`. */
export function localClock(now: Date, zone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((piece) => piece.type === type)?.value ?? '0';
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}
