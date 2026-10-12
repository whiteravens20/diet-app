// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaloriePreviewRequest } from '@diet-app/shared';
import { api } from '@/lib/api';
import { aPreview } from '@/testing/calories';
import messages from '../../messages/en.json';
import { CaloriePreviewPanel, useCaloriePreview } from './calorie-preview';

const texts = messages.caloriePreview;

const figures = (over: Partial<CaloriePreviewRequest> = {}): CaloriePreviewRequest => ({
  age: 30,
  sex: 'male',
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'moderate',
  dietType: 'balanced',
  customMacroSplit: null,
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  acknowledgeRisk: false,
  ...over,
});

/** The panel of a form that holds `asked`. */
function Shown({ asked }: { asked: CaloriePreviewRequest | null }) {
  return <CaloriePreviewPanel {...useCaloriePreview(asked)} />;
}

function show(asked: CaloriePreviewRequest | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapped = (of: CaloriePreviewRequest | null) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <Shown asked={of} />
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  const shown = render(wrapped(asked));
  return { type: (of: CaloriePreviewRequest | null) => shown.rerender(wrapped(of)) };
}

/** Let `ms` pass, and what was waiting for them happen: an answer that came in the last of them is shown a moment after. */
const pass = async (ms: number) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await act(() => vi.advanceTimersByTimeAsync(0));
};

describe('what the figures of a form come to', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says what to type while the form holds nothing that can be worked out, and asks for nothing', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    show(null);
    await pass(1000);

    expect(screen.getByText(texts.pending)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('is asked of the API once the typing has paused, and once for all that was typed on the way', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    const { type } = show(null);

    // A weight on its way to being typed: an 8, and then the 0 after it.
    type(figures({ weightKg: 38 }));
    await pass(200);
    type(figures({ weightKg: 80 }));
    await pass(200);
    expect(post).not.toHaveBeenCalled();
    await pass(300);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/profiles/calories', figures({ weightKg: 80 }));
    expect(screen.getByText('2,209 kcal')).toBeInTheDocument();
    expect(screen.getByText('2,759 kcal')).toBeInTheDocument();
    expect(screen.getByText('1,780 kcal')).toBeInTheDocument();
    expect(screen.getByText('550 kcal a day under your maintenance.')).toBeInTheDocument();
    expect(screen.getByText('Protein 138 g · fat 74 g · carbohydrate 249 g a day.')).toBeInTheDocument();
    expect(screen.getByText('Daily target: 2,209 kcal.')).toBeInTheDocument();
  });

  it('says that the figures are on their way while there is something to work out and no answer yet', async () => {
    let answer: (preview: unknown) => void = () => undefined;
    vi.spyOn(api, 'post').mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    const { type } = show(null);

    type(figures());
    // Typed, and the pause not yet over: nothing is asked of the reader any more.
    expect(screen.queryByText(texts.pending)).toBeNull();
    expect(screen.getByRole('status', { name: texts.waiting })).toBeInTheDocument();
    await pass(500);
    expect(screen.getByRole('status', { name: texts.waiting })).toBeInTheDocument();

    answer(aPreview());
    await pass(0);

    expect(screen.queryByRole('status', { name: texts.waiting })).toBeNull();
    expect(screen.getByText('2,209 kcal')).toBeInTheDocument();
  });

  it('is asked at once for the figures a form begins with', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    show(figures());
    await pass(0);

    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByText('2,209 kcal')).toBeInTheDocument();
  });

  it('is not asked again for figures it was asked for before', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    const { type } = show(figures());
    await pass(500);

    type(figures({ weightKg: 81 }));
    await pass(500);
    type(figures());
    await pass(500);

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('shows nothing of figures that can no longer be worked out', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    const { type } = show(figures());
    await pass(500);
    expect(screen.getByText('2,209 kcal')).toBeInTheDocument();

    type(null);

    expect(screen.queryByText('2,209 kcal')).toBeNull();
    expect(screen.getByText(texts.pending)).toBeInTheDocument();
  });

  it('says what stands behind a target that is not maintenance less the pace, and leaves the warnings of a risk to the form', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(aPreview({ dailyTarget: 1500, dailyDeficit: 300, safetyFloorApplied: true, warnings: ['underweight'] }) as never);
    show(figures());
    await pass(500);

    expect(screen.getByText(/The target was raised to 1,500 kcal/)).toBeInTheDocument();
    expect(screen.queryByText(messages.profileSummary.notices.underweight)).toBeNull();
  });

  it('says of a target over maintenance that it is over, and of one at maintenance that no loss is planned', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview({ dailyTarget: 3000, dailyDeficit: -241, source: 'manual_override' }) as never);
    const { type } = show(figures({ manualCalorieTarget: 3000 }));
    await pass(500);
    expect(screen.getByText('241 kcal a day over your maintenance.')).toBeInTheDocument();

    post.mockResolvedValue(aPreview({ dailyTarget: 2759, dailyDeficit: 0, weeklyLossTarget: null }) as never);
    type(figures({ weeklyLossTarget: null }));
    await pass(500);
    expect(screen.getByText(texts.atMaintenance)).toBeInTheDocument();
  });

  it('says that the figures could not be worked out when the API does not answer, and nothing more', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('no answer'));
    show(figures());
    await pass(500);

    expect(screen.getByText(texts.failed)).toBeInTheDocument();
  });
});
