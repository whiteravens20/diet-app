// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanCalendarDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import { PlanCalendar } from './plan-calendar';

const texts = messages.mealPlans.calendar;
const PROFILE = '6f1c2b1e-7a52-4a3a-9d0e-000000000001';
const PLAN = '0b9e8d7c-6f5e-4d3c-8b2a-000000000001';

const aDay = (date: string, over: Partial<PlanCalendarDay> = {}): PlanCalendarDay => ({
  date,
  planId: PLAN,
  plans: 1,
  calories: 2190,
  target: 2200,
  offTarget: null,
  eaten: { meals: 0, of: 3 },
  skipped: false,
  ...over,
});

/** The calendar of a profile whose plans hold `days`, for a reader whose day is the 14th of January 2026, a Wednesday. */
async function open(days: PlanCalendarDay[] = [], answer?: () => Promise<unknown>) {
  const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (answer) return answer() as never;
    const asked = new URLSearchParams(path.split('?')[1]);
    return Promise.resolve({
      days: days.filter((day) => day.date >= asked.get('from')! && day.date <= asked.get('to')!),
    } as never);
  });
  const onOpen = vi.fn();
  const onStart = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PlanCalendar profileId={PROFILE} today="2026-01-14" onOpen={onOpen} onStart={onStart} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(screen.queryByRole('grid')?.getAttribute('aria-busy') ?? 'false').toBe('false'),
  );
  return {
    onOpen,
    onStart,
    /** The spans the calendar was asked for, in order. */
    asked: () =>
      get.mock.calls.map(([path]) =>
        Object.fromEntries(new URLSearchParams(String(path).split('?')[1])),
      ),
  };
}

/** The cell of a day, by how it begins when it is read out. */
const cell = (says: RegExp) => screen.getByRole('button', { name: says });

describe("the calendar of a profile's plans", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the month it is, Monday first, and asks for its whole weeks at once', async () => {
    const { asked } = await open();

    expect(screen.getByRole('heading', { name: 'January 2026' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('grid', { name: 'January 2026' }))
        .getAllByRole('columnheader')
        .map((day) => day.textContent),
    ).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // January 2026 lies in five weeks: from the Monday before its first day to the Sunday after its last.
    expect(screen.getAllByRole('row')).toHaveLength(1 + 5);
    expect(asked()).toEqual([{ profileId: PROFILE, from: '2025-12-29', to: '2026-02-01' }]);
    expect(cell(/^Wed, Jan 14:/)).toHaveAttribute('aria-current', 'date');
  });

  it('says of a day in a plan what it holds, and opens the plan at that day', async () => {
    const { onOpen, onStart } = await open([aDay('2026-01-12', { eaten: { meals: 2, of: 3 } })]);

    const monday = cell(/^Mon, Jan 12:/);

    expect(monday).toHaveAccessibleName(
      'Mon, Jan 12: 2,190 of 2,200 kcal, 2 of 3 meals eaten. Choose it to open the plan.',
    );
    // The button shows the date alone, which its name holds; what the day holds is drawn beside it.
    expect(monday).toHaveTextContent(/^12$/);
    expect(monday.closest('td')).toHaveTextContent('122,1902/3');
    await userEvent.click(monday);
    expect(onOpen).toHaveBeenCalledWith(PLAN, '2026-01-12');
    expect(onStart).not.toHaveBeenCalled();
  });

  it('offers a day no plan holds as the day a plan can begin on', async () => {
    const { onOpen, onStart } = await open([aDay('2026-01-12')]);

    const tuesday = cell(/^Tue, Jan 13:/);

    expect(tuesday).toHaveAccessibleName(
      'Tue, Jan 13: no plan. Choose it to begin a plan on this day.',
    );
    await userEvent.click(tuesday);
    expect(onStart).toHaveBeenCalledWith('2026-01-13');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('says of a day that it is off its target, that the plan skips it, and that more plans hold it', async () => {
    await open([
      aDay('2026-01-12', { calories: 2900, offTarget: 'over' }),
      aDay('2026-01-13', { calories: 1500, offTarget: 'under', plans: 3 }),
      aDay('2026-01-14', { calories: 0, skipped: true, eaten: { meals: 0, of: 0 }, plans: 2 }),
    ]);

    expect(cell(/^Mon, Jan 12:/)).toHaveAccessibleName(
      'Mon, Jan 12: 2,900 of 2,200 kcal, over the target, 0 of 3 meals eaten. Choose it to open the plan.',
    );
    expect(cell(/^Tue, Jan 13:/)).toHaveAccessibleName(
      'Tue, Jan 13: 1,500 of 2,200 kcal, under the target, 0 of 3 meals eaten, and 2 more plans hold this day. Choose it to open the plan.',
    );
    expect(cell(/^Tue, Jan 13:/).closest('td')).toHaveTextContent('131,500+2');
    expect(cell(/^Wed, Jan 14:/)).toHaveAccessibleName(
      'Wed, Jan 14: a day the plan skips, and one more plan holds this day. Choose it to open the plan.',
    );
    expect(cell(/^Wed, Jan 14:/).closest('td')).toHaveTextContent(`14${texts.skipped}+1`);
  });

  it('says in words what the marks in a day mean', async () => {
    await open();

    for (const line of [
      texts.legendDay,
      texts.legendOff,
      texts.legendEaten,
      texts.legendMore,
      texts.legendKeys,
    ])
      expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('leafs to the month after and the one before, and back to the month it is', async () => {
    const { asked } = await open();
    const thisMonth = screen.getByRole('button', { name: texts.thisMonth });
    expect(thisMonth).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: texts.next }));
    expect(screen.getByRole('heading', { name: 'February 2026' })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(asked().at(-1)).toEqual({ profileId: PROFILE, from: '2026-01-26', to: '2026-03-01' }),
    );

    await userEvent.click(screen.getByRole('button', { name: texts.previous }));
    await userEvent.click(screen.getByRole('button', { name: texts.previous }));
    expect(screen.getByRole('heading', { name: 'December 2025' })).toBeInTheDocument();

    await userEvent.click(thisMonth);
    expect(screen.getByRole('heading', { name: 'January 2026' })).toBeInTheDocument();
  });

  it('says that the plans could not be read, and reads them again when asked', async () => {
    let fails = true;
    await open([], () =>
      fails
        ? Promise.reject(new Error('no answer'))
        : Promise.resolve({ days: [aDay('2026-01-12')] }),
    );

    expect(await screen.findByRole('button', { name: messages.common.retry })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    fails = false;
    await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));

    expect(await screen.findByRole('button', { name: /^Mon, Jan 12: 2,190/ })).toBeInTheDocument();
  });
});

describe('the days of the calendar, for somebody who uses the keyboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inTabOrder = () =>
    within(screen.getByRole('grid'))
      .getAllByRole('button')
      .filter((day) => day.tabIndex === 0);

  it('are one stop of the Tab key: the day it is', async () => {
    await open();

    expect(inTabOrder().map((day) => day.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Wed, Jan 14:/),
    ]);
  });

  it('are moved among with the arrow keys, a day or a week at a time, and to either end of a week', async () => {
    await open();
    cell(/^Wed, Jan 14:/).focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(cell(/^Thu, Jan 15:/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(cell(/^Thu, Jan 22:/)).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    expect(cell(/^Wed, Jan 14:/)).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(cell(/^Mon, Jan 12:/)).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(cell(/^Sun, Jan 18:/)).toHaveFocus();
    // The day the keys are at is the one the Tab key comes back to.
    expect(inTabOrder()).toEqual([cell(/^Sun, Jan 18:/)]);
  });

  it('lead into the month after when the keys leave the weeks that are drawn, with the focus on the day they reached', async () => {
    const { asked } = await open();
    cell(/^Thu, Jan 29:/).focus();

    await userEvent.keyboard('{ArrowDown}');

    expect(await screen.findByRole('heading', { name: 'February 2026' })).toBeInTheDocument();
    expect(cell(/^Thu, Feb 5:/)).toHaveFocus();
    expect(asked().at(-1)).toMatchObject({ from: '2026-01-26', to: '2026-03-01' });
  });

  it('go a month on or back with Page Down and Page Up, to the same day of it or to its last', async () => {
    await open();
    cell(/^Sat, Jan 31:/).focus();

    await userEvent.keyboard('{PageDown}');
    expect(screen.getByRole('heading', { name: 'February 2026' })).toBeInTheDocument();
    expect(cell(/^Sat, Feb 28:/)).toHaveFocus();

    await userEvent.keyboard('{PageUp}{PageUp}');
    expect(screen.getByRole('heading', { name: 'December 2025' })).toBeInTheDocument();
    expect(cell(/^Sun, Dec 28:/)).toHaveFocus();
  });

  it('are chosen with Enter like any button', async () => {
    const { onOpen } = await open([aDay('2026-01-14')]);
    cell(/^Wed, Jan 14:/).focus();

    await userEvent.keyboard('{Enter}');

    expect(onOpen).toHaveBeenCalledWith(PLAN, '2026-01-14');
  });
});
