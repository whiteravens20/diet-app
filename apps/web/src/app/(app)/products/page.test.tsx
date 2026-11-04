// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnProduct } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { saveText } from '@/lib/save-file';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import ProductsPage from './page';

vi.mock('@/lib/save-file', () => ({ saveText: vi.fn() }));
vi.mock('next/image', () => ({ default: () => null }));

const t = messages.products;

const A_PRODUCT: OwnProduct = {
  id: '88888888-8888-4888-8888-888888888888',
  code: '5900512320359',
  source: 'own',
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
    sugars: null,
    salt: null,
    saturatedFat: null,
  },
  energyWorkedOut: false,
  doubtful: false,
  correction: false,
  changedAt: null,
  state: 'own',
  reason: null,
  sentAt: null,
  updatedAt: '2026-11-02T10:00:00.000Z',
};

function shown(items: OwnProduct[] = [A_PRODUCT], offered = true) {
  const list = vi.spyOn(api, 'get').mockResolvedValue({ items });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig({ products: { offered, lookups: offered } }));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { list };
}

describe('the page of the products of an account', () => {
  beforeEach(() => vi.mocked(saveText).mockClear());
  afterEach(() => vi.restoreAllMocks());

  it('asks for nothing and says so where the instance has no products', () => {
    const { list } = shown([], false);

    expect(screen.getByText(t.notOffered)).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: t.add })).not.toBeInTheDocument();
  });

  it('says what it is for while it holds nothing', async () => {
    shown([]);

    expect(await screen.findByText(t.emptyTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.add })).toBeInTheDocument();
  });

  it('says what a product is, with its figures and its state', async () => {
    shown();

    expect(await screen.findByText(A_PRODUCT.name)).toBeInTheDocument();
    expect(screen.getByText('Babcia · 500 g · 5900512320359')).toBeInTheDocument();
    expect(screen.getByText(t.state.own)).toBeInTheDocument();
    expect(
      screen.getByText('245 kcal in 100 g · protein 8 g, fat 3 g, carbohydrates 45 g'),
    ).toBeInTheDocument();
    expect(screen.queryByText(t.doubtful)).not.toBeInTheDocument();
  });

  it('says of a figure left out that it is not known, and that one not accepted says why', async () => {
    shown([
      {
        ...A_PRODUCT,
        state: 'rejected',
        reason: 'The label says otherwise.',
        doubtful: true,
        per100: { ...A_PRODUCT.per100, fat: null },
      },
    ]);

    expect(await screen.findByText(t.state.rejected)).toBeInTheDocument();
    expect(screen.getByText('Reason: The label says otherwise.')).toBeInTheDocument();
    expect(screen.getByText(t.doubtful)).toBeInTheDocument();
    expect(screen.getByText(/protein 8 g, fat — g/)).toBeInTheDocument();
  });

  it('says of a correction whose it stays and where it reaches everybody, and offers no sending', async () => {
    shown([{ ...A_PRODUCT, correction: true }]);

    expect(await screen.findByText(t.state.correction)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'correct the product at Open Food Facts' }),
    ).toHaveAttribute('href', `https://world.openfoodfacts.org/product/${A_PRODUCT.code}`);
    expect(screen.queryByRole('button', { name: t.send })).not.toBeInTheDocument();
    expect(screen.queryByText(t.sendNeeds)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.edit })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.remove })).toBeInTheDocument();
  });

  it('says what sending does before it does it, and sends on that word alone', async () => {
    const { list } = shown();
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ...A_PRODUCT, state: 'sent' });

    await userEvent.click(await screen.findByRole('button', { name: t.send }));

    expect(screen.getByText(t.sendNote)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    const asked = list.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: t.sendConfirm }));

    expect(post).toHaveBeenCalledWith(`/products/own/${A_PRODUCT.id}/send`);
    await waitFor(() => expect(screen.queryByText(t.sendNote)).not.toBeInTheDocument());
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(asked));
  });

  it.each([
    ['its code', { code: null }],
    ['its protein', { per100: { ...A_PRODUCT.per100, protein: null } }],
    ['its fat', { per100: { ...A_PRODUCT.per100, fat: null } }],
    ['its carbohydrates', { per100: { ...A_PRODUCT.per100, carbs: null } }],
  ])('cannot send a product without %s, and says what it needs', async (_, lacking) => {
    shown([{ ...A_PRODUCT, ...lacking }]);

    expect(await screen.findByRole('button', { name: t.send })).toBeDisabled();
    expect(screen.getByText(t.sendNeeds)).toBeInTheDocument();
  });

  it('takes a waiting product back at once, in place of sending it', async () => {
    shown([{ ...A_PRODUCT, state: 'sent' }]);
    const post = vi.spyOn(api, 'post').mockResolvedValue(A_PRODUCT);

    await userEvent.click(await screen.findByRole('button', { name: t.withdraw }));

    expect(post).toHaveBeenCalledWith(`/products/own/${A_PRODUCT.id}/withdraw`);
    expect(screen.queryByRole('button', { name: t.send })).not.toBeInTheDocument();
    expect(screen.getByText(t.state.sent)).toBeInTheDocument();
  });

  it('removes a product only after saying what that does', async () => {
    shown();
    const away = vi.spyOn(api, 'delete').mockResolvedValue(undefined);

    await userEvent.click(await screen.findByRole('button', { name: t.remove }));

    expect(screen.getByText(t.removeNote)).toBeInTheDocument();
    expect(away).not.toHaveBeenCalled();
    const asked = screen.getAllByRole('button', { name: t.removeConfirm });
    await userEvent.click(asked.at(-1)!);

    expect(away).toHaveBeenCalledWith(`/products/own/${A_PRODUCT.id}`);
  });

  it('lets a question go unanswered', async () => {
    shown();

    await userEvent.click(await screen.findByRole('button', { name: t.send }));
    await userEvent.click(screen.getByRole('button', { name: t.cancel }));

    expect(screen.queryByText(t.sendNote)).not.toBeInTheDocument();
  });

  it('says why a product was not sent', async () => {
    shown();
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiClientError(429, 'OWN_PRODUCT_SEND_LIMIT', 'Too many.'),
    );

    await userEvent.click(await screen.findByRole('button', { name: t.send }));
    await userEvent.click(screen.getByRole('button', { name: t.sendConfirm }));

    // At the product it was asked of, which may be far down the list.
    const row = screen.getByRole('listitem');
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      messages.errors.OWN_PRODUCT_SEND_LIMIT,
    );
  });

  it("hands over the file of the instance's additions, as a file", async () => {
    const additions = { license: 'ODbL-1.0', products: [] };
    shown();
    await screen.findByText(A_PRODUCT.name);
    vi.spyOn(api, 'get').mockResolvedValue(additions);

    await userEvent.click(screen.getByRole('button', { name: t.file }));

    await waitFor(() => expect(saveText).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/products/additions');
    expect(JSON.parse(vi.mocked(saveText).mock.calls[0]![0])).toEqual(additions);
    expect(vi.mocked(saveText).mock.calls[0]![1]).toBe('products-added.json');
  });

  it('says why the file was not given', async () => {
    shown();
    await screen.findByText(A_PRODUCT.name);
    vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(429, 'RATE_LIMITED', 'Wait.'));

    await userEvent.click(screen.getByRole('button', { name: t.file }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(saveText).not.toHaveBeenCalled();
  });

  it('writes a new product in a window, which closes when it is saved', async () => {
    shown([]);
    await screen.findByText(t.emptyTitle);
    const post = vi.spyOn(api, 'post').mockResolvedValue(A_PRODUCT);

    await userEvent.click(screen.getByRole('button', { name: t.add }));
    const window = within(screen.getByRole('dialog', { name: t.addTitle, hidden: true }));
    await userEvent.type(window.getByRole('textbox', { name: t.name, hidden: true }), 'Chleb');
    await userEvent.type(window.getByRole('textbox', { name: t.calories, hidden: true }), '245');
    await userEvent.click(window.getByRole('button', { name: t.save, hidden: true }));

    expect(post).toHaveBeenCalledWith('/products/own', expect.objectContaining({ name: 'Chleb' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
  });

  it('changes a product in a window that holds it', async () => {
    shown();

    await userEvent.click(await screen.findByRole('button', { name: t.edit }));

    const window = within(screen.getByRole('dialog', { name: t.editTitle, hidden: true }));
    expect(window.getByRole('textbox', { name: t.name, hidden: true })).toHaveValue(A_PRODUCT.name);
  });
});
