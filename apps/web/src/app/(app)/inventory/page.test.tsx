// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ingredient, InventoryItem, type Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import messages from '../../../../messages/en.json';
import InventoryPage from './page';

const texts = messages.inventory;
/** What stands between an amount and its unit, so that they are never parted at the end of a line. */
const NBSP = '\u00a0';

const profile = { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000001', name: 'Anna' } as Profile;

/** A drink measured in millilitres whose bottle has a weight, but which has no density: the API keeps it in millilitres alone. */
const bottled = Ingredient.parse({
  id: '2dad81f3-0d9d-44e1-9ef3-000000000001',
  name: 'Bottled kefir',
  category: 'dairy',
  canonicalUnit: 'ml',
  caloriesPer100: 50,
  proteinPer100: 3,
  fatPer100: 2,
  carbsPer100: 4,
  gramsPerPiece: 400,
  displayUnit: 'piece',
  recipeUnits: ['ml'],
  pantryUnits: ['ml'],
});

/** Something measured in pieces, each of a known weight, with no density: pieces first, or grams. */
const dumplings = Ingredient.parse({
  id: '2dad81f3-0d9d-44e1-9ef3-000000000002',
  name: 'Frozen dumplings',
  category: 'other',
  canonicalUnit: 'piece',
  caloriesPer100: 4000,
  proteinPer100: 150,
  fatPer100: 100,
  carbsPer100: 600,
  gramsPerPiece: 25,
  recipeUnits: ['piece', 'g'],
  pantryUnits: ['piece', 'g'],
});

/** A row of the pantry: `quantity` pieces of `ingredient`, best before `bestBefore`. */
const aRow = (ingredient: Ingredient, quantity: number, bestBefore: string | null): InventoryItem =>
  InventoryItem.parse({
    id: ingredient.id.replace('2dad81f3', '7c0ffee0'),
    ingredient,
    quantity,
    unit: 'piece',
    display: { quantity, unit: ingredient.displayUnit ?? 'piece' },
    bestBefore,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  });

/** The pantry page of an account with one profile whose pantry holds `rows`; a search finds `found`. */
async function open(found: Ingredient[], rows: InventoryItem[] = []) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles'
        ? [profile]
        : path.startsWith('/ingredients?')
          ? found
          : path.startsWith('/inventory?')
            ? rows
            : []) as never,
    ),
  );
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <InventoryPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findAllByText(rows.length > 0 ? rows[0]!.ingredient.name : texts.emptyTitle);
  return { post };
}

/** Find an ingredient by a part of its name and pick it. */
async function pick(ingredient: Ingredient) {
  await userEvent.type(screen.getByLabelText(texts.ingredientLabel), ingredient.name.slice(0, 4));
  await userEvent.click(await screen.findByRole('button', { name: ingredient.name }));
}

const unitsOffered = () =>
  within(screen.getByLabelText(texts.unitLabel))
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);

describe('the form that puts an ingredient into the pantry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers only the units the API says the ingredient can be kept in, and starts at the first of them', async () => {
    const { post } = await open([bottled]);

    await pick(bottled);

    // Its bottles cannot be turned into millilitres without a density.
    expect(unitsOffered()).toEqual(['ml']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('ml');
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));
    expect(post).toHaveBeenCalledWith(
      '/inventory',
      expect.objectContaining({ ingredientId: bottled.id, quantity: 500, unit: 'ml' }),
    );
  });

  it('offers grams of what is kept in pieces of a known weight, as the API says', async () => {
    await open([dumplings]);

    await pick(dumplings);

    expect(unitsOffered()).toEqual(['piece', 'g']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('piece');
  });

  it('dates what goes into the freezer 30 days on, keeps a date typed, and takes the date it wrote away with the box', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    const date = screen.getByLabelText(texts.bestBeforeLabel);
    const box = screen.getByRole('checkbox', { name: texts.frozenLabel });

    await userEvent.click(box);
    expect(date).toHaveValue(dayAfter(localDate(), 30));
    await userEvent.click(box);
    expect(date).toHaveValue('');

    fireEvent.change(date, { target: { value: '2027-03-01' } });
    await userEvent.click(box);
    expect(date).toHaveValue('2027-03-01');
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));

    expect(post).toHaveBeenCalledWith(
      '/inventory',
      expect.objectContaining({ ingredientId: bottled.id, bestBefore: '2027-03-01', frozen: true }),
    );
    // The next one starts fresh.
    expect(box).not.toBeChecked();
  });

  it('sends nothing of the freezer for what is added fresh, and asks no portions of it', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);

    expect(screen.queryByLabelText(texts.portionsLabel)).toBeNull();
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));

    expect(post.mock.calls[0]![1]).not.toHaveProperty('frozen');
    expect(post.mock.calls[0]![1]).not.toHaveProperty('portions');
  });

  it('splits what goes into the freezer into the portions asked, saying what each holds', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '1000');
    const portions = screen.getByLabelText(texts.portionsLabel);

    // One package is the whole amount: nothing to say of it, nothing to send.
    expect(portions).toHaveValue(1);
    expect(screen.queryByText(/portions of/)).toBeNull();
    await userEvent.clear(portions);
    await userEvent.type(portions, '4');
    expect(portions).toHaveAccessibleDescription(`4${NBSP}portions of 250${NBSP}ml each`);
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));

    expect(post).toHaveBeenCalledWith(
      '/inventory',
      expect.objectContaining({
        ingredientId: bottled.id,
        quantity: 1000,
        frozen: true,
        portions: 4,
      }),
    );
    // The next one is one package again.
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    expect(screen.getByLabelText(texts.portionsLabel)).toHaveValue(1);
  });

  it('sends no portions for what goes into the freezer whole', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '1000');

    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));

    expect(post.mock.calls[0]![1]).toMatchObject({ frozen: true });
    expect(post.mock.calls[0]![1]).not.toHaveProperty('portions');
  });

  it('adds nothing split into portions of less than one of its unit, and says why', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '5');
    const portions = screen.getByLabelText(texts.portionsLabel);

    await userEvent.clear(portions);
    await userEvent.type(portions, '10');

    expect(portions).toHaveAccessibleDescription(messages.errors.PORTIONS_TOO_MANY);
    expect(screen.getByRole('button', { name: texts.addButton })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '0');
    expect(portions).toHaveAccessibleDescription(`10${NBSP}portions of 5${NBSP}ml each`);
    expect(screen.getByRole('button', { name: texts.addButton })).toBeEnabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('offers nothing but pieces for what is counted', async () => {
    const egg = Ingredient.parse({
      ...dumplings,
      id: '2dad81f3-0d9d-44e1-9ef3-000000000004',
      name: 'Large egg',
      canonicalUnit: 'g',
      gramsPerPiece: 55,
      displayUnit: 'piece',
      recipeUnits: ['g', 'piece'],
      pantryUnits: ['piece'],
    });
    await open([egg]);

    await pick(egg);

    expect(unitsOffered()).toEqual(['piece']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('piece');
  });
});

describe('a row of the pantry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names its amount and its day after its ingredient, so that one row is told from another', async () => {
    const garlic = Ingredient.parse({
      ...dumplings,
      id: '2dad81f3-0d9d-44e1-9ef3-000000000003',
      name: 'Garlic',
      canonicalUnit: 'g',
      gramsPerPiece: 5,
      displayUnit: 'clove',
      recipeUnits: ['g', 'piece'],
      pantryUnits: ['piece'],
    });
    await open([], [aRow(dumplings, 12, '2026-11-05'), aRow(garlic, 3, null)]);

    expect(screen.getByLabelText(texts.quantityOf.replace('{name}', dumplings.name))).toHaveValue(
      12,
    );
    expect(screen.getByLabelText(texts.bestBeforeOf.replace('{name}', dumplings.name))).toHaveValue(
      '2026-11-05',
    );
    expect(screen.getByLabelText(texts.quantityOf.replace('{name}', 'Garlic'))).toHaveValue(3);
    expect(screen.getByLabelText(texts.bestBeforeOf.replace('{name}', 'Garlic'))).toHaveValue('');
  });

  it('takes neither an empty amount nor one under nothing, and shows again the amount kept', async () => {
    const row = aRow(dumplings, 12, null);
    await open([], [row]);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    const amount = screen.getByLabelText(texts.quantityOf.replace('{name}', dumplings.name));

    await userEvent.clear(amount);
    await userEvent.type(amount, '-5');
    await userEvent.tab();
    expect(amount).toHaveValue(12);
    await userEvent.clear(amount);
    await userEvent.tab();
    expect(amount).toHaveValue(12);
    expect(patch).not.toHaveBeenCalled();

    await userEvent.clear(amount);
    await userEvent.type(amount, '10');
    await userEvent.tab();
    expect(patch).toHaveBeenCalledWith(`/inventory/${row.id}`, { quantity: 10 });
  });

  describe('in the freezer', () => {
    const chicken = Ingredient.parse({
      ...dumplings,
      id: '2dad81f3-0d9d-44e1-9ef3-000000000004',
      name: 'Chicken breast',
      category: 'meat',
      canonicalUnit: 'g',
      gramsPerPiece: null,
      displayUnit: null,
      recipeUnits: ['g'],
      pantryUnits: ['g'],
    });
    const grams = (quantity: number, frozen: boolean, bestBefore: string): InventoryItem =>
      InventoryItem.parse({
        id: `7c0ffee0-0d9d-44e1-9ef3-00000000000${frozen ? 'b' : 'a'}`,
        ingredient: chicken,
        quantity,
        unit: 'g',
        display: { quantity, unit: 'g' },
        bestBefore,
        frozen,
        createdAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      });

    it('stands after the fresh row of its food, says it is frozen, and each field says which row it is of', async () => {
      await open(
        [],
        [
          aRow(dumplings, 12, null),
          grams(286, true, '2026-12-14'),
          grams(100, false, '2026-11-16'),
        ],
      );

      const fresh = screen.getByLabelText(texts.quantityOf.replace('{name}', chicken.name));
      const frozen = screen.getByLabelText(
        texts.quantityOf.replace('{name}', texts.frozenName.replace('{name}', chicken.name)),
      );
      expect(fresh).toHaveValue(100);
      expect(frozen).toHaveValue(286);
      expect(fresh.compareDocumentPosition(frozen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        screen.getByLabelText(
          texts.bestBeforeOf.replace('{name}', texts.frozenName.replace('{name}', chicken.name)),
        ),
      ).toHaveValue('2026-12-14');
      expect(screen.getAllByText(texts.frozen)).toHaveLength(1);
    });

    it('leaves its food to be added fresh', async () => {
      await open([chicken], [aRow(dumplings, 12, null), grams(286, true, '2026-12-14')]);

      await pick(chicken);

      expect(screen.getByRole('button', { name: texts.clearPick })).toBeInTheDocument();
    });

    it('offers a food the freezer holds already, for a package of its own', async () => {
      await open([chicken], [grams(286, true, '2026-12-14')]);
      await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));

      await pick(chicken);

      expect(screen.getByRole('button', { name: texts.clearPick })).toBeInTheDocument();
    });

    it('stands its packages one after another, the one going off first first, each told by its number', async () => {
      const later = {
        ...grams(300, true, '2027-01-10'),
        id: '7c0ffee0-0d9d-44e1-9ef3-00000000000c',
      };
      await open([], [later, grams(100, false, '2026-11-16'), grams(286, true, '2026-12-14')]);

      const package_ = (number: number) =>
        screen.getByLabelText(
          texts.quantityOf.replace(
            '{name}',
            texts.frozenPackageName
              .replace('{name}', chicken.name)
              .replace('{number}', String(number)),
          ),
        );
      expect(package_(1)).toHaveValue(286);
      expect(package_(2)).toHaveValue(300);
      expect(
        package_(1).compareDocumentPosition(package_(2)) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('takes a food the pantry holds fresh, once the box says it goes into the freezer', async () => {
      await open([chicken], [grams(100, false, '2026-11-16')]);
      const search = screen.getByLabelText(texts.ingredientLabel);

      await userEvent.type(search, 'Chic');
      expect(screen.queryByRole('button', { name: chicken.name })).toBeNull();
      await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));

      expect(await screen.findByRole('button', { name: chicken.name })).toBeInTheDocument();
    });

    const freezeOf = (name: string) => texts.freezeLabel.replace('{name}', name);

    it('is where a fresh row goes from the window its button opens, which a frozen row has not', async () => {
      const fresh = grams(100, false, '2026-11-16');
      const { post } = await open(
        [],
        [aRow(dumplings, 12, null), fresh, grams(286, true, '2026-12-14')],
      );
      // The pantry as the API answers it: the fresh row gone, its packages in the freezer.
      const packages = [1, 2, 3, 4].map((n) => ({
        ...grams(25, true, '2026-12-16'),
        id: `7c0ffee0-0d9d-44e1-9ef3-0000000000${10 + n}`,
      }));
      post.mockResolvedValueOnce([
        aRow(dumplings, 12, null),
        grams(286, true, '2026-12-14'),
        ...packages,
      ] as never);

      expect(
        screen.queryByRole('button', {
          name: freezeOf(texts.frozenName.replace('{name}', chicken.name)),
        }),
      ).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = screen.getByRole('dialog', { name: texts.freeze });
      const portions = within(window).getByLabelText(texts.portionsLabel);
      expect(portions).toHaveValue(1);
      await userEvent.clear(portions);
      await userEvent.type(portions, '4');
      expect(portions).toHaveAccessibleDescription(`4${NBSP}portions of 25${NBSP}g each`);
      await userEvent.click(within(window).getByRole('button', { name: texts.freeze }));

      expect(post).toHaveBeenCalledWith(`/inventory/${fresh.id}/freeze`, { portions: 4 });
      expect(await screen.findAllByText(texts.frozen)).toHaveLength(5);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('button', { name: freezeOf(chicken.name) })).toBeNull();
    });

    it('freezes a row whole as one package, unless told otherwise', async () => {
      const fresh = grams(100, false, '2026-11-16');
      const { post } = await open([], [fresh]);
      post.mockResolvedValueOnce([grams(100, true, '2026-12-16')] as never);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: texts.freeze }),
      );

      expect(post).toHaveBeenCalledWith(`/inventory/${fresh.id}/freeze`, { portions: 1 });
    });

    it('splits what is counted into whole pieces, as evenly as they go', async () => {
      await open([], [aRow(dumplings, 6, null)]);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(dumplings.name) }));
      const portions = within(screen.getByRole('dialog')).getByLabelText(texts.portionsLabel);
      await userEvent.clear(portions);
      await userEvent.type(portions, '4');

      expect(portions).toHaveAccessibleDescription(
        `Portions: 2${NBSP}pieces, 2${NBSP}pieces, 1${NBSP}piece, and 1${NBSP}piece`,
      );
    });

    it('says what each package holds as the pantry will show it: pieces to the half, the rest to the gram', async () => {
      await open([], [aRow(dumplings, 2.3, null), grams(1000, false, '2026-11-16')]);
      const split = async (name: string) => {
        await userEvent.click(screen.getByRole('button', { name: freezeOf(name) }));
        const portions = within(screen.getByRole('dialog')).getByLabelText(texts.portionsLabel);
        await userEvent.clear(portions);
        await userEvent.type(portions, name === chicken.name ? '3' : '2');
        return portions;
      };

      expect(await split(dumplings.name)).toHaveAccessibleDescription(
        `Portions: 1${NBSP}piece and 1.5${NBSP}pieces`,
      );
      await userEvent.click(screen.getByRole('button', { name: messages.common.cancel }));
      expect(await split(chicken.name)).toHaveAccessibleDescription(
        `3${NBSP}portions of 333${NBSP}g each`,
      );
    });

    it('freezes nothing split into portions of less than one of its unit, and says why', async () => {
      const { post } = await open([], [aRow(dumplings, 3, null)]);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(dumplings.name) }));
      const window = screen.getByRole('dialog');
      const portions = within(window).getByLabelText(texts.portionsLabel);
      await userEvent.clear(portions);
      await userEvent.type(portions, '4');

      expect(portions).toHaveAccessibleDescription(messages.errors.PORTIONS_TOO_MANY);
      expect(within(window).getByRole('button', { name: texts.freeze })).toBeDisabled();
      expect(post).not.toHaveBeenCalled();
    });

    it('says so in its window where a row could not be put into it, and keeps the window open', async () => {
      const { post } = await open([], [grams(100, false, '2026-11-16')]);
      post.mockRejectedValueOnce(new Error('offline'));

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = screen.getByRole('dialog');
      await userEvent.click(within(window).getByRole('button', { name: texts.freeze }));

      expect(await within(window).findByRole('alert')).toHaveTextContent(texts.errFreeze);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
