// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { MacrosOffWhy as Why } from '@diet-app/shared';
import messages from '../../../../messages/en.json';
import { MacrosOffWhy } from './macros-off-why';

const texts = messages.mealPlans.macrosOffWhy;

function shown(why: Why) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MacrosOffWhy why={why} mealName={(slot) => slot} />
    </NextIntlClientProvider>,
  );
}

describe("why a day's macros are off", () => {
  it('says what the day holds too much and too little of, and each setting of its plan that keeps it so', () => {
    shown({
      over: 'carbs',
      under: 'protein',
      causes: [{ kind: 'noWaste' }, { kind: 'repeats', count: 1 }, { kind: 'proteinKinds' }],
    });

    expect(screen.getByText('Too much carbohydrate, too little protein.')).toBeVisible();
    expect(screen.getByText(texts.noWaste)).toBeVisible();
    expect(
      screen.getByText(texts.repeats.replace('{count, number, ::group-off}', '1')),
    ).toBeVisible();
    expect(screen.getByText(texts.proteinKinds)).toBeVisible();
    expect(screen.queryByText(texts.diet)).toBeNull();
  });
});
