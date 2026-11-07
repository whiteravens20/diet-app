// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnProduct, Product } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { OwnProductForm } from './own-product-form';
import { plain } from '@/testing/spaces';

const t = messages.products;

const BASE: Product = {
  id: '77777777-7777-4777-8777-777777777777',
  code: '5900512320359',
  source: 'open_food_facts',
  name: 'Mleko 3,2%',
  brand: 'Mlekovita',
  pack: '1l',
  unit: 'ml',
  packAmount: 1000,
  servingAmount: 250,
  per100: {
    calories: 60,
    protein: 3.2,
    fat: 3.2,
    carbs: 4.7,
    fiber: null,
    sugars: 4.7,
    salt: 0.1,
    saturatedFat: 2.1,
  },
  energyWorkedOut: false,
  doubtful: false,
  correction: false,
  changedAt: null,
};

const MINE: OwnProduct = {
  ...BASE,
  id: '88888888-8888-4888-8888-888888888888',
  source: 'own',
  name: 'Chleb babci',
  state: 'own',
  reason: null,
  sentAt: null,
  updatedAt: '2026-11-02T10:00:00.000Z',
};

function shown(
  props: Partial<Parameters<typeof OwnProductForm>[0]> = {},
): Record<'onSaved' | 'onCancel', ReturnType<typeof vi.fn>> {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OwnProductForm onSaved={onSaved} onCancel={onCancel} {...props} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onSaved, onCancel };
}

/** A field by its label, whatever its hint or what is wrong with it says beside that. */
const field = (name: string): HTMLElement =>
  screen.getByRole('textbox', { name: (said) => said.startsWith(name) });
const save = (): Promise<void> => userEvent.click(screen.getByRole('button', { name: t.save }));

describe("the form a product of one's own is written in", () => {
  afterEach(() => vi.restoreAllMocks());

  it('says of every field but the name and the calories that it may stay empty', () => {
    shown();

    const optional = (name: string) => field(name).closest('[data-optional]') !== null;
    expect(optional(t.name)).toBe(false);
    expect(optional(t.calories)).toBe(false);
    for (const name of [t.code, t.brand, t.pack, t.protein, t.fat, t.carbs, t.salt])
      expect(optional(name)).toBe(true);
  });

  it('needs no more than a name and the calories: what is left empty goes as nothing, a comma as a point', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(MINE);
    const { onSaved } = shown();

    await userEvent.type(field(t.name), '  Chleb babci ');
    await userEvent.type(field(t.calories), '245,5');
    await userEvent.type(field(t.protein), '8');
    await save();

    expect(post).toHaveBeenCalledWith('/products/own', {
      code: null,
      name: 'Chleb babci',
      brand: null,
      pack: null,
      unit: 'g',
      packAmount: null,
      servingAmount: null,
      per100: {
        calories: 245.5,
        protein: 8,
        fat: null,
        saturatedFat: null,
        carbs: null,
        sugars: null,
        fiber: null,
        salt: null,
      },
    });
    expect(onSaved).toHaveBeenCalledWith(MINE);
  });

  it('starts with the code it was opened for, and sends it as it was read', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(MINE);
    shown({ code: '5900512320359' });

    expect(field(t.code)).toHaveValue('5900512320359');
    await userEvent.type(field(t.name), 'Mleko');
    await userEvent.type(field(t.calories), '60');
    await save();

    expect(post.mock.calls[0]![1]).toMatchObject({ code: '5900512320359' });
  });

  it.each([
    ['a code that is none', t.code, '123', t.errCode],
    ['a calorie figure above what food has', t.calories, '901', t.errCalories],
    ['a figure that is no number', t.salt, 'dużo', t.errFigure],
    ['more of something than there is food', t.protein, '101', t.errFigure],
    ['a pack of nothing', t.packAmount.replace('{unit}', 'g'), '0', t.errAmount],
    [
      'a serving of more than can be',
      t.servingAmount.replace('{unit}', 'g'),
      '100001',
      t.errAmount,
    ],
  ])('says of %s what is wrong with it, and sends nothing', async (_, label, typed, said) => {
    const post = vi.spyOn(api, 'post');
    shown();

    await userEvent.type(field(t.name), 'Chleb');
    if (label !== t.calories) await userEvent.type(field(t.calories), '100');
    await userEvent.type(field(label), typed);
    expect(screen.queryByText(plain(said))).not.toBeInTheDocument();
    await save();

    expect(screen.getByText(plain(said))).toBeInTheDocument();
    expect(field(label)).toHaveAttribute('aria-invalid', 'true');
    expect(post).not.toHaveBeenCalled();
  });

  it('brings the first field that is wrong into view, wherever the button was pressed from', async () => {
    shown();

    await userEvent.type(field(t.name), 'Chleb');
    await userEvent.type(field(t.code), '123');
    await userEvent.type(field(t.calories), '100');
    await save();

    expect(field(t.code)).toHaveFocus();
  });

  it('says that a name and the calories are needed', async () => {
    const post = vi.spyOn(api, 'post');
    shown();

    await userEvent.type(field(t.name), ' - ');
    await save();

    expect(screen.getByText(t.errName)).toBeInTheDocument();
    expect(screen.getByText(plain(t.errCalories))).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses figures that cannot be true together', async () => {
    const post = vi.spyOn(api, 'post');
    shown();

    await userEvent.type(field(t.name), 'Chleb');
    await userEvent.type(field(t.calories), '400');
    await userEvent.type(field(t.protein), '50');
    await userEvent.type(field(t.fat), '10');
    await userEvent.type(field(t.saturatedFat), '11');
    await userEvent.type(field(t.carbs), '50');
    await userEvent.type(field(t.sugars), '51');
    await save();

    expect(screen.getByText(plain(t.errMacros))).toBeInTheDocument();
    expect(screen.getByText(t.errSaturated)).toBeInTheDocument();
    expect(screen.getByText(t.errSugars)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('holds what it was opened with, changes that product and no other, and warns that a waiting one leaves the queue', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(MINE);
    shown({ product: { ...MINE, state: 'sent' } });

    expect(field(t.name)).toHaveValue('Chleb babci');
    expect(field(t.calories)).toHaveValue('60');
    expect(field(t.fiber)).toHaveValue('');
    expect(screen.getByText(t.changeLeavesQueue)).toBeInTheDocument();
    await save();

    expect(patch).toHaveBeenCalledWith(`/products/own/${MINE.id}`, expect.anything());
  });

  it('says nothing of the queue for a product that is not in it', () => {
    shown({ product: MINE });

    expect(screen.queryByText(t.changeLeavesQueue)).not.toBeInTheDocument();
  });

  describe('as a correction of a product of the base', () => {
    it("starts from the base's figures and code, and says where a correction reaches everybody", async () => {
      const post = vi.spyOn(api, 'post').mockResolvedValue({ ...MINE, correction: true });
      const { onSaved } = shown({ from: BASE });

      expect(field(t.code)).toHaveValue(BASE.code);
      expect(field(t.name)).toHaveValue(BASE.name);
      expect(field(t.calories)).toHaveValue('60');
      expect(field(t.fiber)).toHaveValue('');
      const off = screen.getByRole('link', { name: 'correct the product at Open Food Facts' });
      expect(off).toHaveAttribute('href', `https://world.openfoodfacts.org/product/${BASE.code}`);
      await userEvent.clear(field(t.calories));
      await userEvent.type(field(t.calories), '64');
      await save();

      expect(post).toHaveBeenCalledWith(
        '/products/own',
        expect.objectContaining({
          code: BASE.code,
          per100: expect.objectContaining({ calories: 64 }),
        }),
      );
      expect(onSaved).toHaveBeenCalledWith({ ...MINE, correction: true });
    });

    it('says nothing of Open Food Facts for a product written from nothing', () => {
      shown({ code: BASE.code! });

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  it('says a refusal in words and stays open', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiClientError(409, 'OWN_PRODUCT_LIMIT', 'Too many.'),
    );
    const { onSaved } = shown();

    await userEvent.type(field(t.name), 'Chleb');
    await userEvent.type(field(t.calories), '100');
    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      plain(messages.errors.OWN_PRODUCT_LIMIT),
    );
    expect(field(t.name)).toHaveValue('Chleb');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('can be given up', async () => {
    const { onCancel } = shown();

    await userEvent.click(screen.getByRole('button', { name: t.cancel }));

    expect(onCancel).toHaveBeenCalled();
  });
});
