// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiGenerationMeta,
  ListProposal,
  ListProposals as Proposals,
  ShoppingList,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { ListProposals } from './list-proposals';

const texts = messages.shoppingLists.proposals;
const PLAN = '11111111-1111-4111-8111-111111111111';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const list = {
  id: '22222222-2222-4222-8222-222222222222',
  planId: PLAN,
  fromDate: '2026-01-05',
  toDate: '2026-01-07',
} as ShoppingList;

const merge: ListProposal = {
  kind: 'merge',
  from: { ingredientId: 'rice', name: 'White rice' },
  to: { ingredientId: 'pasta', name: 'Pasta' },
  meals: [
    { plannedMealId: 'meal-1', date: '2026-01-06', mealType: 'lunch', title: 'Chicken with rice' },
    { plannedMealId: 'meal-2', date: '2026-01-07', mealType: 'dinner', title: 'Tofu rice bowl' },
  ],
  packsSaved: 1,
  reason: null,
};
const leftover: ListProposal = {
  kind: 'leftover',
  ingredientId: 'beef',
  name: 'Ground beef',
  unit: 'g',
  left: 320,
  packSize: 500,
  reason: null,
};
const found = (proposals: ListProposal[], aiMeta: Proposals['aiMeta'] = null): Proposals => ({
  planId: PLAN,
  proposals,
  aiMeta,
});
const answered: AiGenerationMeta = {
  provider: 'ollama',
  model: 'test-model',
  failoverChain: [],
  usedDeterministicFallback: false,
  fallbackReason: null,
  reason: null,
};

function shown(
  plain: Proposals,
  { weighed, aiEnabled = true }: { weighed?: Proposals; aiEnabled?: boolean } = {},
) {
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve(((body as { weigh?: boolean }).weigh ? weighed : plain) as never),
    );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>
        <ListProposals list={list} profileId={PROFILE} aiEnabled={aiEnabled} aiOffNote="why-off" />
        <p id="why-off">AI is off.</p>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post };
}
const ask = () => userEvent.click(screen.getByRole('button', { name: texts.ask }));
/** The proposals on screen: the parts of the page that hold a link to the plan. */
const proposals = () => screen.getAllByRole('listitem').filter((item) => item.querySelector('a'));

describe('what a shopping list could do without', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is asked for, of the list that is shown', async () => {
    const { post } = shown(found([merge]));
    expect(screen.queryByRole('list')).toBeNull();

    await ask();

    expect(post).toHaveBeenCalledWith(`/shopping-lists/${list.id}/proposals`, { weigh: false });
    expect(await screen.findAllByRole('list')).not.toHaveLength(0);
  });

  it('names a row that another could stand for, the meals it is in and the packs it saves, and leads to the plan at the first of those meals', async () => {
    shown(found([merge]));
    await ask();

    const proposal = within((await vi.waitFor(proposals))[0]!);
    expect(proposal.getByText('Pasta').parentElement).toHaveTextContent(
      'Pasta in place of White rice in 2 meals: 1 pack fewer to buy',
    );
    expect(proposal.getAllByRole('listitem').map((meal) => meal.textContent)).toEqual([
      'Tue, Jan 6 · Chicken with rice',
      'Wed, Jan 7 · Tofu rice bowl',
    ]);
    expect(proposal.getByRole('link', { name: texts.mergeHow })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${PROFILE}&plan=${PLAN}&day=2026-01-06`,
    );
    expect(proposal.getByText(texts.mergeThen)).toBeInTheDocument();
  });

  it('names a pack that will be left over, and leads to the plan, which says what would use it up', async () => {
    shown(found([leftover]));
    await ask();

    const proposal = within((await vi.waitFor(proposals))[0]!);
    expect(proposal.getByText('Ground beef').parentElement).toHaveTextContent(
      'Ground beef: 320 g of a pack of 500 g will be left, and an opened pack of it does not keep',
    );
    expect(proposal.getByRole('link', { name: texts.leftoverHow })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${PROFILE}&plan=${PLAN}&day=2026-01-05`,
    );
  });

  it("comes back in a model's order with its sentences when one is asked, and says who put the order", async () => {
    const { post } = shown(found([merge, leftover]), {
      weighed: found([{ ...leftover, reason: 'Freeze what is left.' }, merge], answered),
    });
    await ask();
    await vi.waitFor(proposals);

    await userEvent.click(screen.getByRole('button', { name: messages.weigh.ask }));

    expect(
      await screen.findByText('A model says of this: “Freeze what is left.”'),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`/shopping-lists/${list.id}/proposals`, { weigh: true });
    expect(within(proposals()[0]!).getByText('Ground beef')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(messages.weigh.weighed);
  });

  it('says so when there is nothing, and offers no model to weigh nothing', async () => {
    shown(found([]));
    await ask();

    expect(await screen.findByText(texts.none)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.weigh.ask })).toBeNull();
  });

  it('keeps the button that asks a model in its place on an account with AI off, disabled, with the reason', async () => {
    shown(found([leftover]), { aiEnabled: false });
    await ask();
    await vi.waitFor(proposals);

    const weigh = screen.getByRole('button', { name: messages.weigh.ask });
    expect(weigh).toBeDisabled();
    expect(weigh).toHaveAccessibleDescription('AI is off.');
  });

  it('says so when the list cannot be looked over', async () => {
    const { post } = shown(found([]));
    post.mockRejectedValueOnce(
      new ApiClientError(404, 'LIST_NOT_FOUND', 'Shopping list not found.'),
    );

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.LIST_NOT_FOUND);
  });
});
