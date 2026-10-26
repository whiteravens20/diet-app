// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { aDepth, aPublicConfig } from '@/testing/public-config';
import messages from '../../messages/en.json';
import { SupplyNote } from './supply-note';

/**
 * Render the note for vegans with the catalogue holding `recipes` for the
 * thinnest of four meals and `atFewer` for fewer meals a day; no answer yet
 * when omitted.
 */
function renderNote(recipes?: number, atFewer = 9) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (recipes !== undefined) {
    const depth = aDepth(9);
    depth.vegan = { 2: atFewer, 3: atFewer, 4: recipes, 5: 0 };
    client.setQueryData(['config'], aPublicConfig({ catalogue: { depth } }));
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <SupplyNote diet="vegan" mealCount={4} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('the note on what the catalogue has for a diet', () => {
  it('says no plan can be made from the catalogue when one of the meals has no recipe, and how many meals a day can be planned', () => {
    renderNote(0);

    expect(screen.getByRole('status').textContent).toBe(
      'The catalogue has no recipe on the "Vegan" diet for at least one of the 4 meals a day. Without a recipe of your own for that meal no plan can be made: choose another diet, or no more than 3 meals a day.',
    );
  });

  it('does not advise fewer meals when no number of them can be planned', () => {
    renderNote(0, 0);

    expect(screen.getByRole('status').textContent).toBe(
      'The catalogue has no recipe on the "Vegan" diet for at least one of the 4 meals a day. Without a recipe of your own for that meal no plan can be made: choose another diet.',
    );
  });

  it('says plans will repeat when one of the meals has few, and how few', () => {
    renderNote(2);
    expect(screen.getByRole('status').textContent).toContain(
      'one of the 4 meals a day has only 2 recipes to choose from',
    );
  });

  it('counts a single recipe as one', () => {
    renderNote(1);
    expect(screen.getByRole('status').textContent).toContain('has only 1 recipe to choose from');
  });

  it('says nothing when there are enough', () => {
    renderNote(3);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing before the catalogue answered', () => {
    renderNote();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
