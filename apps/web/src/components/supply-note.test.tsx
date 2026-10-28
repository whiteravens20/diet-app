// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { Supply } from '@diet-app/shared';
import { aPublicConfig, aSupply } from '@/testing/public-config';
import messages from '../../messages/en.json';
import { SupplyNote } from './supply-note';

/** Render the note for vegans at four meals a day, of which the API says `found`; no answer yet when omitted. */
function renderNote(found?: Supply) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (found !== undefined) {
    const supply = aSupply();
    supply.vegan['4'] = found;
    client.setQueryData(['config'], aPublicConfig({ catalogue: { supply } }));
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
    renderNote({ level: 'none', recipes: 0, fewerMeals: 3 });

    expect(screen.getByRole('status').textContent).toBe(
      'The catalogue has no recipe on the "Vegan" diet for at least one of the 4 meals a day. Without a recipe of your own for that meal no plan can be made: choose another diet, or no more than 3 meals a day.',
    );
  });

  it('does not advise fewer meals when no number of them can be planned', () => {
    renderNote({ level: 'none', recipes: 0, fewerMeals: null });

    expect(screen.getByRole('status').textContent).toBe(
      'The catalogue has no recipe on the "Vegan" diet for at least one of the 4 meals a day. Without a recipe of your own for that meal no plan can be made: choose another diet.',
    );
  });

  it('says plans will repeat when one of the meals has few, and how few', () => {
    renderNote({ level: 'thin', recipes: 2, fewerMeals: 3 });
    expect(screen.getByRole('status').textContent).toContain(
      'one of the 4 meals a day has only 2 recipes to choose from',
    );
  });

  it('counts a single recipe as one', () => {
    renderNote({ level: 'thin', recipes: 1, fewerMeals: 3 });
    expect(screen.getByRole('status').textContent).toContain('has only 1 recipe to choose from');
  });

  it('says nothing when there are enough', () => {
    renderNote({ level: 'enough', recipes: 3, fewerMeals: 3 });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing before the catalogue answered', () => {
    renderNote();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
