// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiGenerationMeta, DayVariation, DayVariations } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { DayVariationsDialog } from './day-variations-dialog';

const texts = messages.mealPlans.variations;
const PLAN = '11111111-1111-4111-8111-111111111111';
const DAY = { id: '22222222-2222-4222-8222-222222222222', date: '2026-01-06' };
const PATH = `/meal-plans/${PLAN}/days/${DAY.id}/variations`;

const aMeal = (mealType: DayVariation['meals'][number]['mealType'], title: string, kcal: number, stays = false): DayVariation['meals'][number] => ({
  mealType,
  title,
  recipeId: stays ? null : `recipe-${title}`,
  servings: 1,
  nutrition: { calories: kcal, protein: 30, fat: 20, carbs: 60 },
  stays,
});
const aWay = (offer: string, dinner: string, over: Partial<DayVariation> = {}): DayVariation => ({
  meals: [aMeal('breakfast', 'Oat porridge', 450), aMeal('lunch', 'A slice of cake', 250, true), aMeal('dinner', dinner, 700)],
  dayNutrition: { calories: 1400, protein: 90, fat: 60, carbs: 180 },
  packs: { bought: 1500, used: 900, wasted: 1 },
  reason: null,
  offer,
  ...over,
});
const theWays = (variations: DayVariation[], aiMeta: DayVariations['aiMeta'] = null): DayVariations => ({
  date: DAY.date,
  calorieTarget: 2000,
  current: { dayNutrition: { calories: 1950, protein: 100, fat: 70, carbs: 220 }, packs: { bought: 1500, used: 650, wasted: 2 } },
  variations,
  aiMeta,
});
const answered: AiGenerationMeta = { provider: 'ollama', model: 'test-model', failoverChain: [], usedDeterministicFallback: false, fallbackReason: null, reason: null };

/** The window, open on a day, with the API answering `first` to the first request and `weighed` to the one that asks a model. */
async function opened(first: DayVariations | ApiClientError, { weighed, aiEnabled = true }: { weighed?: DayVariations; aiEnabled?: boolean } = {}) {
  const post = vi.spyOn(api, 'post').mockImplementation((path: string, body?: unknown) => {
    if (path === `${PATH}/take`) return Promise.resolve({} as never);
    if ((body as { weigh?: boolean }).weigh) return Promise.resolve(weighed as never);
    return first instanceof ApiClientError ? Promise.reject(first) : Promise.resolve(first as never);
  });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DayVariationsDialog planId={PLAN} day={DAY} aiEnabled={aiEnabled} aiOffNote="why-off" mealName={(type) => type} onClose={onClose} onChanged={onChanged} />
        <p id="why-off">AI is off.</p>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  const dialog = within(await screen.findByRole('dialog', { name: 'Other ways to fill Tue, Jan 6' }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith(PATH, { weigh: false }));
  return { dialog, post, onClose, onChanged };
}
/** The ways on screen, each as a part of the page. */
const ways = (dialog: Awaited<ReturnType<typeof opened>>['dialog']) => dialog.getAllByRole('listitem').filter((item) => item.querySelector('h3'));

describe('the window that offers other ways to fill a day', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows each way with its meals, what the day would hold, and what the plan would leave of its packs', async () => {
    const { dialog } = await opened(theWays([aWay('offer-1', 'Lentil soup'), aWay('offer-2', 'Tofu bowl', { packs: { bought: 1500, used: 650, wasted: 0 } })]));

    expect(await dialog.findByText('As it is: 1,950 of 2,000 kcal. The plan leaves 2 opened packs more than three tenths full.')).toBeInTheDocument();
    const [first, second] = ways(dialog);
    expect(within(first!).getByRole('heading', { level: 3 })).toHaveTextContent('Way 1');
    expect(within(first!).getAllByRole('listitem').map((meal) => meal.textContent)).toEqual(['breakfast · Oat porridge · 450 kcal', 'lunch · A slice of cake · 250 kcalstays', 'dinner · Lentil soup · 700 kcal']);
    expect(within(first!).getByText('1,400 of 2,000 kcal · protein 90 g · fat 60 g · carbs 180 g')).toBeInTheDocument();
    expect(within(first!).getByText('With it the plan would leave 1 opened pack more than three tenths full.')).toBeInTheDocument();
    expect(within(second!).getByText('With it the plan would leave no opened pack more than three tenths full.')).toBeInTheDocument();
  });

  it('takes the way that is chosen with the note that came with it, tells the page and closes', async () => {
    const { dialog, post, onClose, onChanged } = await opened(theWays([aWay('offer-1', 'Lentil soup'), aWay('offer-2', 'Tofu bowl')]));
    await dialog.findByText('Way 2');

    await userEvent.click(within(ways(dialog)[1]!).getByRole('button', { name: texts.take }));

    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(`${PATH}/take`, { offer: 'offer-2' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('says so where the catalogue leaves no other way, and offers no model to weigh nothing', async () => {
    const { dialog } = await opened(theWays([]));

    expect(await dialog.findByText(texts.none)).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: messages.weigh.ask })).toBeNull();
  });

  it('puts the ways in the order a model gave when one is asked, with its sentence on each, and says who put the order', async () => {
    const soup = aWay('offer-1', 'Lentil soup');
    const bowl = aWay('offer-2', 'Tofu bowl');
    const { dialog, post } = await opened(theWays([soup, bowl]), { weighed: theWays([{ ...bowl, offer: 'offer-2w', reason: 'Finishes the tofu.' }, { ...soup, offer: 'offer-1w' }], answered) });
    await dialog.findByText('Way 2');

    await userEvent.click(dialog.getByRole('button', { name: messages.weigh.ask }));

    expect(await dialog.findByText('A model says of this: “Finishes the tofu.”')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(PATH, { weigh: true });
    expect(within(ways(dialog)[0]!).getByText(/Tofu bowl/)).toBeInTheDocument();
    expect(dialog.getByRole('status')).toHaveTextContent(messages.weigh.weighed);
    // The way that is taken now is taken with the note of the weighed offer.
    await userEvent.click(within(ways(dialog)[0]!).getByRole('button', { name: texts.take }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(`${PATH}/take`, { offer: 'offer-2w' }));
  });

  it('says why the engine\'s order stands when the model was no help', async () => {
    const way = aWay('offer-1', 'Lentil soup');
    const { dialog } = await opened(theWays([way]), { weighed: theWays([way], { ...answered, provider: null, model: null, usedDeterministicFallback: true, fallbackReason: 'quota_exhausted' }) });
    await dialog.findByText('Way 1');

    await userEvent.click(dialog.getByRole('button', { name: messages.weigh.ask }));

    expect(await dialog.findByText(messages.aiFallback.quota_exhausted)).toBeInTheDocument();
  });

  it('keeps the button that asks a model in its place on an account with AI off, disabled, with the reason', async () => {
    const { dialog } = await opened(theWays([aWay('offer-1', 'Lentil soup')]), { aiEnabled: false });
    await dialog.findByText('Way 1');

    const ask = dialog.getByRole('button', { name: messages.weigh.ask });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAccessibleDescription('AI is off.');
  });

  it('says what stood in the way when the ways cannot be worked out', async () => {
    const { dialog } = await opened(new ApiClientError(409, 'NOTHING_TO_REGENERATE', 'Every day asked for is before today.'));

    expect(await dialog.findByRole('alert')).toHaveTextContent(messages.errors.NOTHING_TO_REGENERATE);
  });

  it('says so when the plan had changed under the offer, and tells the page to read the plan anew', async () => {
    const { dialog, post, onClose, onChanged } = await opened(theWays([aWay('offer-1', 'Lentil soup')]));
    await dialog.findByText('Way 1');
    post.mockRejectedValueOnce(new ApiClientError(409, 'PLAN_CHANGED', 'The plan changed.'));

    await userEvent.click(dialog.getByRole('button', { name: texts.take }));

    expect(await dialog.findByRole('alert')).toHaveTextContent(messages.errors.PLAN_CHANGED);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});
