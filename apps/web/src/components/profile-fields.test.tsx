// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { plain } from '@/testing/spaces';
import { OwnTargetField, RiskNote } from './profile-fields';

const texts = messages.profile;

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
