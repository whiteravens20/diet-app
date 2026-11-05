// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { NO_LABEL_LIMITS } from '@diet-app/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import pl from '../../../../messages/pl.json';
import { LabelLimitFields, labelLimitsIn } from './label-limit-fields';

function form(initial = NO_LABEL_LIMITS) {
  render(
    <NextIntlClientProvider locale="pl" messages={pl}>
      <form data-testid="form">
        <LabelLimitFields initial={initial} />
      </form>
    </NextIntlClientProvider>,
  );
  return () => labelLimitsIn(new FormData(screen.getByTestId('form') as HTMLFormElement));
}

describe('the limits of a label in a profile', () => {
  it('are all off at first, and one ticked starts where it is advised', async () => {
    const read = form();
    expect(read()).toEqual(NO_LABEL_LIMITS);
    expect(screen.queryByRole('spinbutton')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: pl.profile.labelLimit.saltAtMost }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: pl.profile.labelLimit.fiberAtLeast }),
    );
    expect(read()).toEqual({ ...NO_LABEL_LIMITS, saltAtMost: 5, fiberAtLeast: 25 });
  });

  it('show what the profile set, and take a number typed, or nothing once unticked', async () => {
    const read = form({ ...NO_LABEL_LIMITS, sugarsAtMost: 60 });
    const sugars = screen.getByRole('spinbutton', { name: pl.profile.labelLimit.sugarsAtMost });
    expect(sugars).toHaveValue(60);
    await userEvent.clear(sugars);
    await userEvent.type(sugars, '45');
    expect(read().sugarsAtMost).toBe(45);

    await userEvent.click(
      screen.getByRole('checkbox', { name: pl.profile.labelLimit.sugarsAtMost }),
    );
    expect(read().sugarsAtMost).toBeNull();
  });
});
