// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMode, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { AiRecipeDraftModal } from './ai-recipe-draft-modal';

const profile = {
  id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f',
  name: 'Me',
  dietType: 'balanced',
  preferences: { favoriteIngredientIds: [], excludedIngredientIds: [], allergens: [] },
} as unknown as Profile;

/** The window for an account whose AI is in `mode`. */
function opened(mode: AiMode) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path === '/users/me' ? { aiMode: mode } : []) as never),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The account is known by the time the window can be opened: its button waits for it.
  client.setQueryData(['session'], { aiMode: mode });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <AiRecipeDraftModal profile={profile} onClose={() => {}} onCreated={() => {}} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the window that drafts a recipe with a model', () => {
  it("says, before anything is asked, that the instance's AI puts the recipe before the curators", () => {
    opened('admin');

    expect(screen.getByText(messages.aiRecipeDraft.curatorsNote)).toBeInTheDocument();
  });

  it('says nothing of the curators to an account that uses its own key', () => {
    opened('byok');

    expect(screen.getByText(messages.aiRecipeDraft.determinismHint)).toBeInTheDocument();
    expect(screen.queryByText(messages.aiRecipeDraft.curatorsNote)).not.toBeInTheDocument();
  });
});
