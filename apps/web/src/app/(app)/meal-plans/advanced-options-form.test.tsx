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
        <AdvancedOptions dates={[]} defaultMealCount={3} favorites={[]} sets={[]} defaultMaxRepeats={null} value={{ days: {} }} onChange={() => {}} />
      </NextIntlClientProvider>,
    );

    for (const kind of PLAN_RELAXATIONS) {
      expect(screen.getByRole('checkbox', { name: messages.mealPlans.limit[kind] })).toHaveAccessibleDescription(messages.mealPlans.advanced.limitWhere[kind]);
    }
  });
});
