// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Product, PublicConfig } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { aPublicConfig } from '@/testing/public-config';
import en from '../../../../messages/en.json';
import pl from '../../../../messages/pl.json';
import { AddEntryDialog } from './add-entry-dialog';

const texts = en.diary;

const MILK: Product = {
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
  changedAt: '2026-08-28T14:32:51.000Z',
};

const offered: PublicConfig['products'] = { offered: true, lookups: true };

/** The window as a page opens it, on an instance that says the given of its products. */
function renderWindow(products = offered, messages: typeof en = en, locale = 'en') {
  const onSubmit = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig({ products }));
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <QueryClientProvider client={client}>
        <AddEntryDialog
          meal="snack"
          date="2026-11-02"
          busy={false}
          error={null}
          onClose={vi.fn()}
          onSubmit={onSubmit}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { window: within(screen.getByRole('dialog')), onSubmit };
}

/** The window with products chosen as what to add, and the field to look for one in. */
async function openOnProducts(products = offered) {
  const opened = renderWindow(products);
  const user = userEvent.setup();
  await user.click(opened.window.getByRole('radio', { name: texts.kindProduct }));
  return { ...opened, user, field: opened.window.getByRole('searchbox') };
}

describe('a product in the window that adds to a diary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not offered where the instance offers none', () => {
    const { window } = renderWindow({ offered: false, lookups: false });
    expect(window.queryByRole('radio', { name: texts.kindProduct })).not.toBeInTheDocument();
    expect(window.getByRole('radio', { name: texts.kindMeal })).toBeInTheDocument();
  });

  describe('found by its name', () => {
    it('is looked for among what the instance holds, and offered with its brand', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue({ items: [MILK] } as never);
      const { window, user, field } = await openOnProducts();

      await user.type(field, 'mleko');

      const found = await window.findByRole('button', { name: /Mleko 3,2%, Mlekovita/ });
      expect(found).toHaveTextContent('60 kcal in 100 ml');
      expect(get).toHaveBeenCalledWith('/products?search=mleko');
    });

    it('says that the instance knows nothing of it, and leads to the code', async () => {
      vi.spyOn(api, 'get').mockResolvedValue({ items: [] } as never);
      const { window, user, field } = await openOnProducts();
      await user.type(field, 'nic takiego');
      expect(await window.findByText(texts.productNothingHere)).toBeInTheDocument();
    });

    it("leads from a search to a product of one's own, with no code to start with", async () => {
      vi.spyOn(api, 'get').mockResolvedValue({ items: [] });
      const { window, field, user } = await openOnProducts();

      await user.type(field, 'chleb babci');
      await user.click(await window.findByRole('button', { name: texts.productAddOwn }));

      expect(
        await window.findByRole('textbox', { name: (said) => said.startsWith(en.products.code) }),
      ).toHaveValue('');
    });

    it("marks a product of one's own among what is found", async () => {
      vi.spyOn(api, 'get').mockResolvedValue({ items: [{ ...MILK, source: 'own' }] });
      const { window, field, user } = await openOnProducts();

      await user.type(field, 'mleko');

      expect(await window.findByText(/· your own$/)).toBeInTheDocument();
    });

    it('says when a search got no answer, which is not that nothing was found', async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(0, 'NETWORK', 'No answer.'));
      const { window, user, field } = await openOnProducts();
      await user.type(field, 'mleko');
      expect(await window.findByText(texts.searchFailed)).toBeInTheDocument();
      expect(window.queryByText(texts.productNothingHere)).not.toBeInTheDocument();
    });

    it.each(['m', 'ml', 'a b', '%%%'])(
      'asks nothing of %s, and says nothing of it',
      async (typed) => {
        const get = vi.spyOn(api, 'get').mockResolvedValue({ items: [] } as never);
        const { window, user, field } = await openOnProducts();
        await user.type(field, typed);
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(get).not.toHaveBeenCalled();
        expect(window.queryByText(texts.productNothingHere)).not.toBeInTheDocument();
      },
    );

    it('takes a word of two signs in a script that writes words that short', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue({ items: [] } as never);
      const { user, field } = await openOnProducts();
      await user.type(field, '牛乳');
      await vi.waitFor(() =>
        expect(get).toHaveBeenCalledWith(`/products?search=${encodeURIComponent('牛乳')}`),
      );
    });
  });

  describe('found by its code', () => {
    it('is asked about only when somebody says so, whatever digits stand in the field', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue(MILK as never);
      const { window, user, field } = await openOnProducts();

      // Eight digits on the way to thirteen can be a code too, and asking about one counts.
      await user.type(field, '59005123');
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(get).not.toHaveBeenCalled();

      await user.type(field, '20359');
      await user.click(window.getByRole('button', { name: texts.productCheck }));

      expect(get).toHaveBeenCalledWith('/products/code/5900512320359');
      expect(await window.findByText('Mleko 3,2%')).toBeInTheDocument();
    });

    it('is asked about by Enter, without sending the window', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue(MILK as never);
      const { window, user, field, onSubmit } = await openOnProducts();
      await user.type(field, '5900512320359{Enter}');
      expect(get).toHaveBeenCalledTimes(1);
      await window.findByText('Mleko 3,2%');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('takes the spellings a person reads off a pack', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue(MILK as never);
      const { user, field } = await openOnProducts();
      await user.type(field, '5 900512 320359{Enter}');
      expect(get).toHaveBeenCalledWith('/products/code/5900512320359');
    });

    it('says of a mistyped code that it is one, and asks nobody', async () => {
      const get = vi.spyOn(api, 'get');
      const { window, user, field } = await openOnProducts();
      await user.type(field, '5900512320358{Enter}');
      expect(window.getByRole('alert')).toHaveTextContent(texts.productCodeBad);
      expect(get).not.toHaveBeenCalled();

      // Going on typing takes the words back.
      await user.type(field, '1');
      expect(window.queryByRole('alert')).not.toBeInTheDocument();
    });

    it("leads from a code nobody knows to a product of one's own with that code, which it then adds", async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'No.'));
      const own: Product = { ...MILK, source: 'own', servingAmount: 200, name: 'Moje mleko' };
      const post = vi.spyOn(api, 'post').mockResolvedValue(own);
      const { window, field, user, onSubmit } = await openOnProducts();

      await user.type(field, '590 0512 320359');
      await user.click(window.getByRole('button', { name: texts.productCheck }));
      await user.click(await window.findByRole('button', { name: texts.productAddOwn }));

      const code = await window.findByRole('textbox', {
        name: (said) => said.startsWith(en.products.code),
      });
      expect(code).toHaveValue(MILK.code);
      await user.type(window.getByRole('textbox', { name: en.products.name }), 'Moje mleko');
      await user.type(window.getByRole('textbox', { name: en.products.calories }), '60');
      await user.click(window.getByRole('button', { name: en.products.save }));

      expect(post.mock.calls[0]![0]).toBe('/products/own');
      expect(await window.findByText('Moje mleko')).toBeInTheDocument();
      expect(window.getByText(texts.productSourceOwn)).toBeInTheDocument();
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(200);
      await user.click(window.getByRole('button', { name: texts.submit }));
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ productId: own.id, quantity: 200 }),
      );
    });

    it("takes the base's product where the code turned out to be known", async () => {
      const get = vi
        .spyOn(api, 'get')
        .mockRejectedValueOnce(new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'No.'));
      vi.spyOn(api, 'post').mockRejectedValue(
        new ApiClientError(409, 'PRODUCT_CODE_KNOWN', 'Known.'),
      );
      const { window, field, user } = await openOnProducts();

      await user.type(field, MILK.code!);
      await user.click(window.getByRole('button', { name: texts.productCheck }));
      await user.click(await window.findByRole('button', { name: texts.productAddOwn }));
      get.mockResolvedValue(MILK);
      await user.type(await window.findByRole('textbox', { name: en.products.name }), 'Moje mleko');
      await user.type(window.getByRole('textbox', { name: en.products.calories }), '60');
      await user.click(window.getByRole('button', { name: en.products.save }));
      await user.click(await window.findByRole('button', { name: en.products.useBase }));

      expect(window.getByText(texts.labelEnergy)).toBeInTheDocument();
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(250);
    });

    it('comes back to the search as it was when the writing is given up', async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'No.'));
      const { window, field, user } = await openOnProducts();

      await user.type(field, MILK.code!);
      await user.click(window.getByRole('button', { name: texts.productCheck }));
      await user.click(await window.findByRole('button', { name: texts.productAddOwn }));
      await user.click(await window.findByRole('button', { name: en.products.cancel }));

      expect(window.getByRole('searchbox')).toHaveValue(MILK.code);
      expect(window.queryByRole('textbox', { name: en.products.name })).not.toBeInTheDocument();
    });

    it("offers no product of one's own where the refusal is not that it is unknown", async () => {
      vi.spyOn(api, 'get').mockRejectedValue(
        new ApiClientError(429, 'PRODUCT_LOOKUPS_BUSY', 'Enough.'),
      );
      const { window, field, user } = await openOnProducts();

      await user.type(field, MILK.code!);
      await user.click(window.getByRole('button', { name: texts.productCheck }));

      await window.findByRole('alert');
      expect(window.queryByRole('button', { name: texts.productAddOwn })).not.toBeInTheDocument();
    });

    it("says who does not know a code, and leads to a meal of one's own", async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'No.'));
      const { window, user, field } = await openOnProducts();
      await user.type(field, '5900512320359{Enter}');
      expect(await window.findByRole('alert')).toHaveTextContent(texts.productNotFound);
      await user.click(window.getByRole('button', { name: texts.productAsOwn }));
      expect(window.getByRole('radio', { name: texts.kindMeal })).toBeChecked();
    });

    it('says only of the instance where it asks nobody else', async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'No.'));
      const { window, user, field } = await openOnProducts({ offered: true, lookups: false });
      await user.type(field, '5900512320359{Enter}');
      expect(await window.findByRole('alert')).toHaveTextContent(texts.productNotFoundHere);
    });

    it('says what a refusal of the lookup is, in words', async () => {
      vi.spyOn(api, 'get').mockRejectedValue(
        new ApiClientError(429, 'PRODUCT_LOOKUPS_USED_UP', 'Used up.'),
      );
      const { window, user, field } = await openOnProducts();
      await user.type(field, '5900512320359{Enter}');
      expect(await window.findByRole('alert')).toHaveTextContent(en.errors.PRODUCT_LOOKUPS_USED_UP);
    });
  });

  describe('once picked', () => {
    const picked = async (product: Product = MILK) => {
      vi.spyOn(api, 'get').mockResolvedValue(product as never);
      const opened = await openOnProducts();
      await opened.user.type(opened.field, '5900512320359{Enter}');
      await opened.window.findByText(product.name);
      return opened;
    };

    it('shows its label as a label reads, with what is unknown said to be so', async () => {
      const { window } = await picked();
      expect(window.getByText('In 100 ml')).toBeInTheDocument();
      expect(window.getByText('Mlekovita · 1l')).toBeInTheDocument();
      const row = (name: string) => window.getByText(name).closest('div')!;
      expect(row(texts.labelEnergy)).toHaveTextContent('60 kcal');
      expect(row(texts.labelProtein)).toHaveTextContent('3.2 g');
      expect(row(texts.labelSalt)).toHaveTextContent('0.1 g');
      // No fibre on the label is no fibre known, not none.
      expect(row(texts.labelFiber)).toHaveTextContent(texts.labelUnknown);
    });

    it('says where its figures come from, under which licence, with both links', async () => {
      const { window } = await picked();
      expect(window.getByRole('link', { name: 'Open Food Facts' })).toHaveAttribute(
        'href',
        'https://world.openfoodfacts.org',
      );
      expect(window.getByRole('link', { name: 'ODbL' })).toHaveAttribute(
        'href',
        'https://opendatacommons.org/licenses/odbl/1-0/',
      );
    });

    it('says of a product people of the instance added where it comes from, with both links', async () => {
      vi.spyOn(api, 'get').mockResolvedValue({ items: [{ ...MILK, source: 'instance' }] });
      const { window, field, user } = await openOnProducts();

      await user.type(field, 'mleko');
      await user.click(await window.findByRole('button', { name: /Mleko/ }));

      const said = window.getByText(/Added by a person using this instance/);
      expect(within(said).getByRole('link', { name: 'ODbL' })).toBeInTheDocument();
      expect(within(said).getByRole('link', { name: 'Open Food Facts' })).toBeInTheDocument();
    });

    it('starts at a serving by its label, and says what it adds', async () => {
      const { window } = await picked();
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(250);
      expect(window.getByText('Adds 150 kcal to the day.')).toBeInTheDocument();
    });

    it('goes to a serving or the whole pack with a press', async () => {
      const { window, user } = await picked();
      const field = window.getByRole('spinbutton', { name: /ml/ });
      await user.click(window.getByRole('button', { name: '1 serving (250 ml)' }));
      expect(field).toHaveValue(250);
      await user.click(window.getByRole('button', { name: 'Whole pack (1000 ml)' }));
      expect(field).toHaveValue(1000);
      expect(window.getByText('Adds 600 kcal to the day.')).toBeInTheDocument();
    });

    it('starts empty where its label gives no serving', async () => {
      const { window } = await picked({ ...MILK, servingAmount: null });
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(null);
      expect(window.queryByRole('button', { name: /serving/ })).not.toBeInTheDocument();
    });

    it('offers no pack a day of a diary could not take', async () => {
      const { window } = await picked({ ...MILK, packAmount: 25000, servingAmount: 8000 });
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(null);
      expect(window.queryByRole('button', { name: /pack/ })).not.toBeInTheDocument();
    });

    it('is sent with its amount, and the meal asked for', async () => {
      const { window, user, onSubmit } = await picked();
      const field = window.getByRole('spinbutton', { name: /ml/ });
      await user.clear(field);
      await user.type(field, '200');
      await user.click(window.getByRole('button', { name: texts.submit }));
      expect(onSubmit).toHaveBeenCalledWith({
        kind: 'product',
        mealType: 'snack',
        productId: MILK.id,
        quantity: 200,
      });
    });

    it('says nothing of what an amount it cannot take would add', async () => {
      const { window, user } = await picked();
      const field = window.getByRole('spinbutton', { name: /ml/ });
      await user.clear(field);
      await user.type(field, '6000');
      expect(window.queryByText(/Adds .* to the day/)).not.toBeInTheDocument();
    });

    it('warns where its figures do not add up, and can still be added', async () => {
      const { window, user, onSubmit } = await picked({ ...MILK, doubtful: true });
      expect(window.getByText(texts.productDoubtful)).toBeInTheDocument();
      await user.click(window.getByRole('button', { name: texts.submit }));
      expect(onSubmit).toHaveBeenCalled();
    });

    it('says that what the label lacks will be an estimate', async () => {
      const { window } = await picked({
        ...MILK,
        per100: { ...MILK.per100, protein: null },
      });
      expect(window.getByText(texts.productLacking)).toBeInTheDocument();
    });

    it("speaks of what was written, not of a label, for a product of one's own", async () => {
      vi.spyOn(api, 'get').mockResolvedValue({
        items: [{ ...MILK, source: 'own', per100: { ...MILK.per100, protein: null } }],
      });
      const { window, field, user } = await openOnProducts();

      await user.type(field, 'mleko');
      await user.click(await window.findByRole('button', { name: /Mleko/ }));

      expect(window.getByText(texts.productLackingOwn)).toBeInTheDocument();
      expect(window.queryByText(texts.productLacking)).not.toBeInTheDocument();
    });

    it('says that an energy worked out is an estimate', async () => {
      const { window } = await picked({ ...MILK, energyWorkedOut: true });
      expect(window.getByText(texts.productEnergyWorkedOut)).toBeInTheDocument();
      expect(window.getByText(texts.labelEnergy).closest('div')).toHaveTextContent('≈ 60 kcal');
    });

    it("without figures cannot be added, and leads to a meal of one's own by its name", async () => {
      const { window, user } = await picked({
        ...MILK,
        per100: { ...MILK.per100, calories: null, protein: null, fat: null, carbs: null },
      });
      expect(window.getByText(texts.productNoFigures)).toBeInTheDocument();
      expect(window.getByRole('button', { name: texts.submit })).toBeDisabled();
      expect(window.getByText(texts.productNoFiguresShort)).toBeInTheDocument();
      expect(window.queryByRole('spinbutton')).not.toBeInTheDocument();

      await user.click(window.getByRole('button', { name: texts.productAsOwn }));
      expect(window.getByRole('radio', { name: texts.kindMeal })).toBeChecked();
      expect(window.getByRole('textbox', { name: texts.mealName })).toHaveValue('Mleko 3,2%');
    });

    it('takes no amount along to another kind, and starts again when it is come back to', async () => {
      const { window, user } = await picked();
      await user.click(window.getByRole('radio', { name: texts.kindIngredient }));
      await user.click(window.getByRole('radio', { name: texts.kindProduct }));
      expect(window.getByRole('spinbutton', { name: /ml/ })).toHaveValue(250);
    });

    it('can be given up for another', async () => {
      const { window, user } = await picked();
      await user.click(window.getByRole('button', { name: texts.changePick }));
      expect(window.getByRole('searchbox')).toHaveValue('');
      expect(window.getByRole('button', { name: texts.submit })).toBeDisabled();
    });
  });

  it('speaks Polish in Polish', async () => {
    const { window } = renderWindow(offered, pl as unknown as typeof en, 'pl');
    const user = userEvent.setup();
    await user.click(window.getByRole('radio', { name: pl.diary.kindProduct }));
    expect(window.getByRole('searchbox')).toHaveAccessibleName(
      `${pl.diary.productField} ${pl.diary.productHint}`,
    );
  });
});
