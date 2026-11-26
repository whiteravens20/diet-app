// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { PLAN_RELAXATIONS } from '@diet-app/shared';
import messages from '../../../../messages/en.json';
import { AdvancedOptions } from './advanced-options';

describe("the plan form's advanced options", () => {
  it('say beside each limit that may give way where that limit is set', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdvancedOptions
          dates={[]}
          defaultMealCount={3}
          favorites={[]}
          sets={[]}
          defaultMaxRepeats={null}
          value={{ days: {} }}
          onChange={() => {}}
        />
      </NextIntlClientProvider>,
    );

    for (const kind of PLAN_RELAXATIONS) {
      expect(
        screen.getByRole('checkbox', { name: messages.mealPlans.limit[kind] }),
      ).toHaveAccessibleDescription(messages.mealPlans.advanced.limitWhere[kind]);
    }
  });

  it("hold each day's own target to the least this body may type, as the plan's own target is", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdvancedOptions
          dates={['2026-01-05', '2026-01-06']}
          defaultMealCount={3}
          favorites={[]}
          sets={[]}
          defaultMaxRepeats={null}
          value={{ days: {} }}
          onChange={() => {}}
          leastTarget={1123}
        />
      </NextIntlClientProvider>,
    );

    const fields = screen.getAllByLabelText(messages.mealPlans.advanced.calories);
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field).toHaveAttribute('min', '1123');
      expect(field).toHaveAttribute('max', '6000');
    }
  });
});
