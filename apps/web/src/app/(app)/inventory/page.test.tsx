// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNDO_FOR_MS } from '@/components/removed-later';
import { Ingredient, InventoryItem, type InventoryPortion, type Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { failReadsAgain } from '@/testing/read-again';
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
  return { post, client };
}

/** The window things are put into the pantry in, opened by the page's button where it is not open yet. */
async function addWindow() {
  if (!screen.queryByRole('dialog', { name: texts.addTitle }))
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));
  return within(screen.getByRole('dialog', { name: texts.addTitle }));
}

/** The window's own button that puts in what it names. */
const submitButton = () =>
  within(screen.getByRole('dialog', { name: texts.addTitle })).getByRole('button', {
    name: texts.addButton,
  });

/** Find an ingredient by a part of its name and pick it, in the window things are added in. */
async function pick(ingredient: Ingredient) {
  const window = await addWindow();
  await userEvent.type(window.getByLabelText(texts.ingredientLabel), ingredient.name.slice(0, 4));
  await userEvent.click(await window.findByRole('button', { name: ingredient.name }));
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
    await userEvent.click(submitButton());
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
    await userEvent.click(submitButton());

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
    await userEvent.click(submitButton());

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
    await userEvent.click(submitButton());

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

    await userEvent.click(submitButton());

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
    expect(submitButton()).toBeDisabled();
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '0');
    expect(portions).toHaveAccessibleDescription(`10${NBSP}portions of 5${NBSP}ml each`);
    expect(submitButton()).toBeEnabled();
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

describe('the window things are put into the pantry in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens over the rows from the button above them, on the search', async () => {
    await open([bottled], [aRow(dumplings, 12, null)]);
    const add = screen.getByRole('button', { name: texts.addButton });

    expect(screen.queryByLabelText(texts.ingredientLabel)).toBeNull();
    expect(
      add.compareDocumentPosition(screen.getByText(dumplings.name)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(add);

    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    await vi.waitFor(() => expect(window.getByLabelText(texts.ingredientLabel)).toHaveFocus());
  });

  it('stays open for the next once one is in: emptied, on the search, saying what went in', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');

    await userEvent.click(submitButton());

    expect(post).toHaveBeenCalledOnce();
    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    await vi.waitFor(() =>
      expect(window.getByRole('status')).toHaveTextContent('Added: Bottled kefir, 500 ml.'),
    );
    expect(window.getByLabelText(texts.ingredientLabel)).toHaveFocus();
    expect(window.getByLabelText(texts.ingredientLabel)).toHaveValue('');
    expect(window.getByLabelText(texts.quantityLabel)).toHaveValue(null);
  });

  it('says what went into the freezer, and in how many portions', async () => {
    await open([bottled]);
    await pick(bottled);
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '1000');
    const portions = screen.getByLabelText(texts.portionsLabel);
    await userEvent.clear(portions);
    await userEvent.type(portions, '4');

    await userEvent.click(submitButton());

    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Added to the freezer: Bottled kefir, 1000 ml in 4 portions.',
      ),
    );
  });

  it('keeps what was typed and says why in the window where the pantry did not take it', async () => {
    const { post } = await open([bottled]);
    post.mockRejectedValueOnce(new ApiClientError(0, 'NETWORK', 'Failed to fetch'));
    await pick(bottled);
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');

    await userEvent.click(submitButton());

    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    expect(await window.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(window.getByLabelText(texts.quantityLabel)).toHaveValue(500);
    expect(window.getByRole('button', { name: texts.clearPick })).toBeInTheDocument();
  });

  it('is closed by its button', async () => {
    await open([bottled]);
    await addWindow();

    await userEvent.click(screen.getByRole('button', { name: messages.common.close }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says in its own words that portions are a whole number from 1 to 10, and puts nothing in', async () => {
    const { post } = await open([bottled]);
    await pick(bottled);
    await userEvent.click(screen.getByRole('checkbox', { name: texts.frozenLabel }));
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '1000');
    const portions = screen.getByLabelText(texts.portionsLabel);

    for (const typed of ['11', '2.5', '0']) {
      await userEvent.clear(portions);
      await userEvent.type(portions, typed);
      expect(portions).toHaveAccessibleDescription(`Type a whole number from 1${NBSP}to 10.`);
      expect(portions).toHaveAttribute('aria-invalid', 'true');
      expect(submitButton()).toBeDisabled();
    }
    await userEvent.clear(portions);
    expect(portions).toHaveAccessibleDescription(`Type a whole number from 1${NBSP}to 10.`);
    expect(post).not.toHaveBeenCalled();
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
      await addWindow();
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
      const search = (await addWindow()).getByLabelText(texts.ingredientLabel);

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

    /** The pantry's API, answering the size a row is frozen in with `answer` from now on. */
    const sizeIs = (answer: InventoryPortion | Error) => {
      const before = vi.mocked(api.get).getMockImplementation()!;
      vi.mocked(api.get).mockImplementation((path: string) =>
        path.endsWith('/portion')
          ? answer instanceof Error
            ? Promise.reject(answer)
            : Promise.resolve(answer as never)
          : before(path),
      );
    };
    const sizeLine = (amount: string) => messages.freezing.portionPlans.replace('{amount}', amount);

    it("says, once the server has, the size the profile's plans eat the food in, where the row is bigger", async () => {
      const fresh = grams(500, false, '2026-11-16');
      await open([], [fresh]);
      sizeIs({ portion: 300, unit: 'g' });

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = within(screen.getByRole('dialog', { name: texts.freeze }));

      expect(await window.findByText(sizeLine('300 g'))).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledWith(`/inventory/${fresh.id}/portion`);
    });

    it("starts its count at the fewest portions none bigger than the plans' portion, which can be changed", async () => {
      const fresh = grams(500, false, '2026-11-16');
      const { post } = await open([], [fresh]);
      sizeIs({ portion: 300, unit: 'g' });
      post.mockResolvedValueOnce([grams(500, true, '2026-12-16')] as never);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = within(screen.getByRole('dialog', { name: texts.freeze }));
      const portions = window.getByLabelText(texts.portionsLabel);
      await vi.waitFor(() => expect(portions).toHaveValue(2));
      expect(portions).toHaveAccessibleDescription(`2${NBSP}portions of 250${NBSP}g each`);
      await userEvent.clear(portions);
      await userEvent.type(portions, '1');
      await userEvent.click(window.getByRole('button', { name: texts.freeze }));

      expect(post).toHaveBeenCalledWith(`/inventory/${fresh.id}/freeze`, { portions: 1 });
    });

    it('says the portion of a row kept in pieces by what its pieces are called, and counts by it', async () => {
      const bread = Ingredient.parse({
        ...dumplings,
        id: '2dad81f3-0d9d-44e1-9ef3-000000000005',
        name: 'Wholegrain bread',
        category: 'grains',
        canonicalUnit: 'g',
        gramsPerPiece: 35,
        displayUnit: 'slice',
        recipeUnits: ['g', 'piece'],
        pantryUnits: ['piece', 'g'],
      });
      const slices = aRow(bread, 10, null);
      await open([], [slices]);
      sizeIs({ portion: 4, unit: 'piece' });

      await userEvent.click(screen.getByRole('button', { name: freezeOf(bread.name) }));
      const window = within(screen.getByRole('dialog', { name: texts.freeze }));

      expect(await window.findByText(sizeLine('4 slices'))).toBeInTheDocument();
      expect(window.getByLabelText(texts.portionsLabel)).toHaveValue(3);
    });

    it.each([
      ['a row no bigger than the portion', { portion: 500, unit: 'g' } as const],
      ['a food no plan takes from packs', { portion: null, unit: 'g' } as const],
      ['an answer that did not come', new Error('offline')],
    ])('says no size for %s, and freezes as before', async (_, answer) => {
      const fresh = grams(500, false, '2026-11-16');
      const { post } = await open([], [fresh]);
      sizeIs(answer);
      post.mockResolvedValueOnce([grams(500, true, '2026-12-16')] as never);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = within(screen.getByRole('dialog', { name: texts.freeze }));
      // The size comes with the rules, and the rules come at once: the answer is in by the time it is read.
      expect(window.getByText(messages.freezing.rulesTitle)).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(api.get).toHaveBeenCalledWith(`/inventory/${fresh.id}/portion`),
      );
      await act(async () => {});
      expect(window.queryByText(/^Split it into portions/)).toBeNull();
      await userEvent.click(window.getByRole('button', { name: texts.freeze }));
      expect(post).toHaveBeenCalledWith(`/inventory/${fresh.id}/freeze`, { portions: 1 });
    });

    it('folds the rules of freezing in its window', async () => {
      await open([], [grams(500, false, '2026-11-16')]);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = within(screen.getByRole('dialog', { name: texts.freeze }));
      const rule = window.getByText(messages.freezing.ruleUseBy);
      expect(rule).not.toBeVisible();
      await userEvent.click(window.getByText(messages.freezing.rulesTitle));
      expect(rule).toBeVisible();
      for (const one of ['ruleLabel', 'ruleThaw', 'ruleRefreeze'] as const)
        expect(window.getByText(messages.freezing[one])).toBeVisible();
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
      // Whole grams, the larger portions first.
      expect(await split(chicken.name)).toHaveAccessibleDescription(
        `Portions: 334${NBSP}g, 333${NBSP}g, and 333${NBSP}g`,
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

    it('says in its own words that portions are a whole number from 1 to 10, with its button off', async () => {
      const { post } = await open([], [grams(1000, false, '2026-11-16')]);

      await userEvent.click(screen.getByRole('button', { name: freezeOf(chicken.name) }));
      const window = screen.getByRole('dialog');
      const portions = within(window).getByLabelText(texts.portionsLabel);
      await userEvent.clear(portions);
      await userEvent.type(portions, '11');

      expect(portions).toHaveAccessibleDescription(`Type a whole number from 1${NBSP}to 10.`);
      expect(within(window).getByRole('button', { name: texts.freeze })).toBeDisabled();
      // Nor does the key that sends a form send it.
      await userEvent.type(portions, '{Enter}');
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

describe('the pantry read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the rows it showed when a read fails again, says why above them, and reads again when asked', async () => {
    const { client } = await open([], [aRow(dumplings, 12, null)]);

    const answerAgain = await failReadsAgain(client);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByText(dumplings.name)).toBeInTheDocument();
    answerAgain();
    await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
    expect(screen.getByText(dumplings.name)).toBeInTheDocument();
  });

  it('says that the pantry could not be read, not that it is empty, when its first read fails', async () => {
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      path === '/profiles'
        ? Promise.resolve([profile] as never)
        : Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch')),
    );
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <InventoryPage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.queryByText(texts.emptyTitle)).toBeNull();
    // The way to put something in stays: it waits for no read.
    expect(screen.getByRole('button', { name: texts.addButton })).toBeEnabled();
  });
});

describe('the search of the pantry form, when it cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says why under the search', async () => {
    await open([dumplings]);
    const answers = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path: string) =>
      path.startsWith('/ingredients?')
        ? Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch'))
        : answers(path),
    );

    await userEvent.type((await addWindow()).getByLabelText(texts.ingredientLabel), 'Froz');

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
  });
});

describe('a row of the pantry taken out', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is gone at once, said with a way to take it back, and sent once the moments for that are over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await open([], [aRow(dumplings, 12, null)]);
    const sent = vi.spyOn(api, 'request').mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: `Remove ${dumplings.name}` }));

    expect(screen.queryByText(dumplings.name)).toBeNull();
    expect(screen.getByText(`Removed: ${dumplings.name}.`)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(UNDO_FOR_MS));
    expect(sent).toHaveBeenCalledWith(`/inventory/${aRow(dumplings, 12, null).id}`, {
      method: 'DELETE',
      keepalive: true,
    });
  });

  it('stays when it is taken back, and nothing is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await open([], [aRow(dumplings, 12, null)]);
    const sent = vi.spyOn(api, 'request').mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: `Remove ${dumplings.name}` }));
    await userEvent.click(screen.getByRole('button', { name: messages.common.undo }));

    expect(screen.getByText(dumplings.name)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(UNDO_FOR_MS * 2));
    expect(sent).not.toHaveBeenCalled();
  });
});
