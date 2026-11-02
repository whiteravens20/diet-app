// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ProductUnderReview } from '@diet-app/shared';
import { ApiClientError } from '@/lib/http';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { ProductQueuePanel, type ProductQueueApi } from './product-queue-panel';

const t = en.productReview;

const WAITING: ProductUnderReview = {
  id: '99999999-9999-4999-8999-999999999999',
  code: '5900512320359',
  name: 'Chleb babci',
  brand: 'Babcia',
  pack: '500 g',
  unit: 'g',
  packAmount: 500,
  servingAmount: 50,
  per100: {
    calories: 245,
    protein: 8,
    fat: 3,
    carbs: 45,
    fiber: null,
    sugars: 2.5,
    salt: 1.2,
    saturatedFat: 0.5,
  },
  energyWorkedOut: false,
  doubtful: false,
  changedAt: null,
  sentAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
};

function aSource(items: ProductUnderReview[] = [WAITING]) {
  return {
    queue: vi.fn().mockResolvedValue({ items, total: items.length }),
    accept: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
  } satisfies ProductQueueApi;
}

function shown(source: ProductQueueApi, messages: typeof en = en, locale = 'en') {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <ProductQueuePanel source={source} onChanged={onChanged} />
    </NextIntlClientProvider>,
  );
  return { onChanged };
}

describe('what accounts sent to the base, for whoever reviews it', () => {
  it('says when nothing waits', async () => {
    shown(aSource([]));

    expect(await screen.findByText(t.nothing)).toBeInTheDocument();
  });

  it('shows every figure of a product, with what it lacks marked, and says how many wait', async () => {
    shown(aSource());

    expect(await screen.findByText(WAITING.name)).toBeInTheDocument();
    expect(screen.getByText(/One product waits/)).toBeInTheDocument();
    expect(screen.getByText('Babcia · 500 g · 5900512320359')).toBeInTheDocument();
    expect(screen.getByText('245')).toBeInTheDocument();
    expect(screen.getByText('2.5')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(t.doubtful)).not.toBeInTheDocument();
  });

  it('says in Polish how many wait, of any number', async () => {
    shown(aSource([WAITING, { ...WAITING, id: '99999999-9999-4999-8999-999999999998' }]), pl, 'pl');

    expect(await screen.findByText(/Czekają 2 produkty/)).toBeInTheDocument();
  });

  it('warns of figures that do not add up', async () => {
    shown(aSource([{ ...WAITING, doubtful: true }]));

    expect(await screen.findByText(t.doubtful)).toBeInTheDocument();
  });

  it('accepts a product as it was seen, and reads the queue again', async () => {
    const source = aSource();
    const { onChanged } = shown(source);

    await userEvent.click(await screen.findByRole('button', { name: t.accept }));

    expect(source.accept).toHaveBeenCalledWith(WAITING.id, WAITING.updatedAt);
    await waitFor(() => expect(source.queue).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it('turns a product down only with what its author is told', async () => {
    const source = aSource();
    shown(source);

    await userEvent.click(await screen.findByRole('button', { name: t.reject }));
    await userEvent.click(screen.getByRole('button', { name: t.rejectConfirm }));
    expect(source.reject).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole('textbox', { name: t.reason }), '  Not on the label. ');
    await userEvent.click(screen.getByRole('button', { name: t.rejectConfirm }));

    expect(source.reject).toHaveBeenCalledWith(WAITING.id, WAITING.updatedAt, 'Not on the label.');
  });

  it('lets a rejection be given up', async () => {
    const source = aSource();
    shown(source);

    await userEvent.click(await screen.findByRole('button', { name: t.reject }));
    await userEvent.click(screen.getByRole('button', { name: en.products.cancel }));

    expect(screen.getByRole('button', { name: t.accept })).toBeInTheDocument();
    expect(source.reject).not.toHaveBeenCalled();
  });

  it('says why a word did not stand, and shows the queue as it now is', async () => {
    const source = aSource();
    source.accept.mockRejectedValue(new ApiClientError(409, 'PRODUCT_CHANGED', 'Changed.'));
    const { onChanged } = shown(source);

    await userEvent.click(await screen.findByRole('button', { name: t.accept }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.PRODUCT_CHANGED);
    await waitFor(() => expect(source.queue).toHaveBeenCalledTimes(2));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says when the queue cannot be read', async () => {
    const source = aSource();
    source.queue.mockRejectedValue(new ApiClientError(500, 'INTERNAL', 'No.'));
    shown(source);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(t.loading)).not.toBeInTheDocument();
  });
});
