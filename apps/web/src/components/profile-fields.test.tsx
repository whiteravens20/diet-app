// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { CalorieCalculation, Profile } from '@diet-app/shared';
import messages from '../../messages/en.json';
import { aPreview } from '@/testing/calories';
import { plain } from '@/testing/spaces';
import { OwnTargetField, PaceChoice, RiskNote } from './profile-fields';

const texts = messages.profile;

/** The paces of a body of 70 at a body-mass index under 30: the two faster ones count as half a kilogram. */
function olderPaces(): CalorieCalculation[] {
  return aPreview().paces.map((pace, index) => ({
    ...pace,
    paceHeldForAge: index >= 3,
    warnings: ['older'],
  }));
}

function choice(initial: Profile['weeklyLossTarget'], paces: CalorieCalculation[]) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PaceChoice initial={initial} paces={paces} unit="kg" />
    </NextIntlClientProvider>,
  );
  return screen.getByRole('group', { name: texts.pace });
}

describe('the choice of a pace of loss', () => {
  it('offers every pace to an adult under 65', () => {
    const group = choice('0.5', aPreview().paces);

    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    expect(within(group).queryByText(plain(texts.paceOlderNote))).toBeNull();
  });

  it('offers from 65 the two slower paces alone, and says why, with the advice for older people', () => {
    const group = choice('0.5', olderPaces());

    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(
      within(group).getByText(
        plain(
          'From 65 a plan loses at most 0.5 kg a week, so that muscle is not lost with the fat.',
        ),
      ),
    ).toBeInTheDocument();
    expect(within(group).getByText(plain(texts.paceOlderNote))).toBeInTheDocument();
  });

  it('keeps a faster pace the profile has from before, said to count as the slower one', () => {
    const group = choice('1.0', olderPaces());
    const radios = within(group).getAllByRole('radio');

    expect(radios).toHaveLength(4);
    expect(radios.at(-1)).toBeChecked();
    expect(within(group).getByText(/counted as 0\.5\s?kg/)).toBeInTheDocument();
  });
});

describe('a calorie target typed by hand', () => {
  it('says the least this body may type, and holds the field to it', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <OwnTargetField initial={null} least={1123} />
      </NextIntlClientProvider>,
    );
    const field = screen.getByLabelText(new RegExp(`^${texts.manualKcalOverride}`));

    expect(field).toHaveAttribute('min', '1123');
    expect(
      screen.getByText(plain('At least 1123 kcal. Leave it empty and the pace decides.')),
    ).toBeInTheDocument();
  });
});

describe('the risk of a loss for a body under 18 or underweight', () => {
  it('says that no loss is planned, with nothing to tick, and where to turn when underweight', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RiskNote reasons={['minor', 'underweight']} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText(plain(texts.risk.minor))).toBeInTheDocument();
    expect(screen.getByText(texts.risk.held)).toBeInTheDocument();
    expect(screen.getByText(texts.risk.help)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says nothing for a body without that risk', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RiskNote reasons={[]} />
      </NextIntlClientProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
