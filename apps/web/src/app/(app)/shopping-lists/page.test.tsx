// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingList } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import * as files from '@/lib/save-file';
import { aPublicConfig } from '@/testing/public-config';
import { failReadsAgain } from '@/testing/read-again';
import messages from '../../../../messages/en.json';
import ShoppingListsPage from './page';
import { plain, spaced } from '@/testing/spaces';

const texts = messages.shoppingLists;
const PLAN = '11111111-1111-4111-8111-111111111111';

/** The address the page is opened at: a link may name the list it leads to. */
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(address.search) }));

type Entry = ShoppingList['groups'][number]['items'][number];

const anEntry = (name: string, category: Entry['category'], over: Partial<Entry> = {}): Entry => ({
  id: `entry-${name}`,
  ingredientId: `ingredient-${name}`,
  name,
  category,
  totalQuantity: 200,
  unit: 'g',
  displayUnit: 'g',
  gramsPerPiece: null,
  alreadyHaveQuantity: 0,
  toBuyQuantity: 200,
  purchasedQuantity: null,
  boughtLooseOn: null,
  byWeight: false,
  frozenKept: 0,
  pantries: [],
  pantryBestBefore: null,
  estimatedCalories: 400,
  packs: null,
  buyLater: [],
  checked: false,
  ...over,
});

/** Two packs of 250 g, for a row that has 435 g left to buy. */
const TWO_PACKS = { count: 2, size: 250, sizeUnit: 'g', quantity: 500 } as const;

const aListOf = (grains: Entry[], vegetables: Entry[]): ShoppingList => ({
  id: '22222222-2222-4222-8222-222222222222',
  planId: PLAN,
  fromDate: '2026-01-05',
  toDate: '2026-01-07',
  groups: [
    {
      category: 'grains',
      items: grains,
      estimatedCalories: grains.reduce((sum, entry) => sum + entry.estimatedCalories, 0),
    },
    {
      category: 'vegetables',
      items: vegetables,
      estimatedCalories: vegetables.reduce((sum, entry) => sum + entry.estimatedCalories, 0),
    },
  ],
  totalEstimatedCalories: [...grains, ...vegetables].reduce(
    (sum, entry) => sum + entry.estimatedCalories,
    0,
  ),
  stale: false,
  household: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const aList = aListOf(
  [anEntry('White rice', 'grains'), anEntry('Rolled oats', 'grains')],
  [anEntry('Broccoli', 'vegetables')],
);

/** The client of the page opened last. */
let shownWith: QueryClient;

async function renderPage(
  list: ShoppingList = aList,
  aiMode: 'none' | 'admin' = 'none',
  others: ShoppingList[] = [],
) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles'
        ? [{ id: 'profile', name: 'Me' }]
        : path === '/users/me'
          ? { aiMode }
          : path.startsWith('/meal-plans?')
            ? {
                items: [
                  { id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' },
                ],
                page: 1,
                pageSize: 50,
                total: 1,
                totalPages: 1,
              }
            : path.startsWith('/shopping-lists?')
              ? [list, ...others]
              : []) as never,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  shownWith = client;
  client.setQueryData(['config'], aPublicConfig());
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <ShoppingListsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return screen.findByRole('button', { name: texts.findEntry });
}

/** The field to look for an entry with, opened by the magnifier in the list's head. */
async function findField(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: texts.findEntry }));
  return screen.getByRole('searchbox', { name: texts.findEntry });
}

/** What can be done with the list as a whole, opened by the button beside the magnifier. */
const listOptions = () => userEvent.click(screen.getByRole('button', { name: texts.listOptions }));

/** The entries on screen, by the name each is ticked by. */
const entries = (): string[] =>
  screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label') ?? '');

describe('a shopping list, looked through for an entry', () => {
  afterEach(() => {
    address.search = '';
    vi.restoreAllMocks();
  });

  it('opens on the list a link names, of the plan and the profile it names', async () => {
    const later = {
      ...aListOf([anEntry('Couscous', 'grains')], [anEntry('Carrot', 'vegetables')]),
      id: '55555555-5555-4555-8555-555555555555',
      fromDate: '2026-01-06',
    };
    address.search = `?profile=66666666-6666-4666-8666-666666666666&plan=${PLAN}&list=${later.id}`;

    await renderPage(aList, 'none', [later]);

    expect(entries()).toEqual(['Couscous', 'Carrot']);
  });

  it('shows every entry under its aisle until something is looked for', async () => {
    await renderPage();

    expect(entries()).toEqual(['White rice', 'Rolled oats', 'Broccoli']);
    expect(screen.getAllByRole('heading', { level: 3 }).map((aisle) => aisle.textContent)).toEqual(
      expect.arrayContaining(['Grains', 'Vegetables']),
    );
  });

  it('keeps the entries whose name holds the words, whatever their case, and the aisles that still have one', async () => {
    await renderPage();
    const find = await findField();

    await userEvent.type(find, 'RIC');

    expect(entries()).toEqual(['White rice']);
    expect(screen.queryByText('Vegetables')).toBeNull();

    await userEvent.clear(find);
    expect(entries()).toHaveLength(3);
  });

  it('says so when no entry has the words in its name', async () => {
    await renderPage();
    const find = await findField();

    await userEvent.type(find, 'salmon');

    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('No entry of this list has “salmon” in its name.')).toBeInTheDocument();
  });

  it('is looked through with a field behind the magnifier, which takes the focus and keeps its words when it is left', async () => {
    const magnifier = await renderPage();

    expect(magnifier).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox')).toBeNull();
    const find = await findField();
    expect(magnifier).toHaveAttribute('aria-expanded', 'true');
    expect(find).toHaveFocus();

    await userEvent.type(find, 'rice');
    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }).closest('ul')!);

    expect(screen.getByRole('searchbox', { name: texts.findEntry })).toHaveValue('rice');
    expect(entries()).toEqual(['White rice']);
  });

  it('gives the whole list back when the magnifier or Escape closes the field, and the focus to the magnifier', async () => {
    const magnifier = await renderPage();

    await userEvent.type(await findField(), 'rice');
    await userEvent.click(magnifier);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(entries()).toHaveLength(3);

    await userEvent.type(await findField(), 'oats');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(entries()).toHaveLength(3);
    expect(magnifier).toHaveFocus();
  });
});

describe('a shopping list, looked over for what it could do without', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const texts = messages.shoppingLists.proposals;
  const leftover = {
    kind: 'leftover',
    ingredientId: 'beef',
    name: 'Ground beef',
    unit: 'g',
    left: 320,
    packSize: 500,
    reason: null,
  } as const;

  it('is asked of the API for the list that is shown, and what comes back leads to the plan of the profile', async () => {
    await renderPage();
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ planId: PLAN, proposals: [leftover], aiMeta: null } as never);

    await userEvent.click(await screen.findByRole('button', { name: texts.ask }));

    expect(post).toHaveBeenCalledWith(`/shopping-lists/${aList.id}/proposals`, { weigh: false });
    expect(await screen.findByRole('link', { name: texts.leftoverHow })).toHaveAttribute(
      'href',
      `/meal-plans?profile=profile&plan=${PLAN}&day=2026-01-05`,
    );
  });

  it('says beside it, on an account with AI off, why no model can be asked', async () => {
    await renderPage();

    expect(await screen.findByText(/AI is off\./)).toBeInTheDocument();
  });

  it('says nothing of that on an account that has a model to ask', async () => {
    await renderPage(aList, 'admin');
    await screen.findByRole('button', { name: texts.ask });

    await vi.waitFor(() => expect(screen.queryByText(/AI is off\./)).toBeNull());
  });
});

describe('a shopping list, by its aisles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what each aisle comes to in kilocalories, as the API worked it out', async () => {
    await renderPage();

    expect(screen.getByText('about 800 kcal')).toBeInTheDocument();
    expect(screen.getByText('about 400 kcal')).toBeInTheDocument();
  });
});

describe('a shopping list, taken somewhere else', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A list of which the oats are done with, and of the rice 50 g are at home. */
  const underWay = aListOf(
    [
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 50,
        toBuyQuantity: 150,
      }),
      anEntry('Rolled oats', 'grains', { purchasedQuantity: 200, checked: true }),
    ],
    [anEntry('Broccoli', 'vegetables', { name: '=Broccoli' })],
  );

  /** The lines of the text that was put on the clipboard. A language may write a range of days with spaces narrower than the one of a keyboard. */
  const copiedBy = (writeText: ReturnType<typeof vi.fn>): string[] =>
    String(writeText.mock.calls[0]![0])
      .replace(/[\u2009\u202f\u00a0]/g, ' ')
      .split('\n');

  it('is copied as a text of what is still to buy, under its aisles, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(underWay);

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText)).toEqual([
      'Shopping list, Jan 5 – 7, 2026',
      '',
      'Grains',
      '- White rice: 150 g',
      '',
      'Vegetables',
      '- =Broccoli: 200 g',
    ]);
    expect(
      await screen.findByText('Copied: 2 entries still to buy, under their aisles.'),
    ).toBeInTheDocument();
  });

  it('is shown to be copied by hand where the browser gives the page no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    await renderPage(underWay);

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    const byHand = within(await screen.findByRole('dialog', { name: texts.copyByHand }));
    expect(byHand.getByText(messages.common.copyByHandHint)).toBeInTheDocument();
    expect(
      (byHand.getByRole('textbox', { name: texts.copyByHand }) as HTMLTextAreaElement).value,
    ).toContain('- White rice: 150 g');
  });

  it('says that nothing is left to buy of a list that is all ticked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(
      aListOf([anEntry('White rice', 'grains', { purchasedQuantity: 200, checked: true })], []),
    );

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText)).toEqual(['Shopping list, Jan 5 – 7, 2026', '', texts.copyNothing]);
    expect(await screen.findByText(texts.copiedNothing)).toBeInTheDocument();
  });

  it('is saved as a table of every row, with its numbers as numbers and no name that a spreadsheet would work out', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await renderPage(underWay);

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.csv }));

    const [file, name, type] = saved.mock.calls[0]!;
    expect(name).toBe('shopping-list-2026-01-05_2026-01-07.csv');
    expect(type).toBe('text/csv');
    expect(file.slice(1).split('\r\n')).toEqual([
      'Aisle,Entry,Needed,Unit,At home,Have in all,Still to buy,Packs,Ticked,kcal (estimate)',
      'Grains,White rice,200,g,50,50,150,,No,400',
      'Grains,Rolled oats,200,g,0,200,0,,Yes,400',
      "Vegetables,'=Broccoli,200,g,0,0,200,,No,400",
      '',
    ]);
  });

  /** Salmon to buy in two packs; eggs at home in part, in a carton of ten; bread of which a part was bought already. */
  const inPacks = aListOf(
    [
      anEntry('Wholegrain bread', 'grains', {
        totalQuantity: 8,
        unit: 'piece',
        displayUnit: 'slice',
        purchasedQuantity: 3,
        toBuyQuantity: 8,
        packs: { count: 1, size: 500, sizeUnit: 'g', quantity: 14 },
      }),
    ],
    [
      anEntry('Salmon', 'vegetables', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }),
      anEntry('Large egg', 'vegetables', {
        totalQuantity: 6,
        unit: 'piece',
        displayUnit: 'piece',
        alreadyHaveQuantity: 2,
        purchasedQuantity: 2,
        toBuyQuantity: 4,
        packs: { count: 1, size: 10, sizeUnit: 'piece', quantity: 10 },
      }),
    ],
  );

  it('says in the text how many packs a row takes, for a row of which nothing was bought yet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(inPacks);

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText).slice(2)).toEqual([
      'Grains',
      '- Wholegrain bread: 5 slices',
      '',
      'Vegetables',
      '- Salmon: 435 g (2 × 250 g)',
      '- Large egg: 4 pieces (1 × 10 pieces)',
    ]);
  });

  it('has a column for the packs in the table', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await renderPage(inPacks);

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.csv }));

    expect(saved.mock.calls[0]![0].slice(1).split('\r\n').slice(1, 4)).toEqual([
      'Grains,Wholegrain bread,8,slices,0,3,5,,No,400',
      'Vegetables,Salmon,435,g,0,0,435,2 × 250 g,No,400',
      'Vegetables,Large egg,6,pieces,2,2,4,1 × 10 pieces,No,400',
    ]);
  });
});

describe('a row of fresh meat or fish needed on a later day', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Chicken for Monday and for Saturday 10 January 2026: two packs, one of them bought from Friday on. */
  const chicken = (over: Partial<Entry> = {}) =>
    anEntry('Chicken breast', 'grains', {
      totalQuantity: 300,
      toBuyQuantity: 300,
      packs: { count: 2, size: 500, sizeUnit: 'g', quantity: 1000 },
      buyLater: [{ packs: 1, from: '2026-01-09' }],
      ...over,
    });
  const later = 'Of these, buy 1 pack on Friday (Jan 9) at the earliest.';

  it('says which of its packs to buy later, and from which day', async () => {
    await renderPage(aListOf([chicken()], []));

    expect(screen.getByText(spaced(later))).toBeInTheDocument();
  });

  it('says it of each day packs are bought on, and nothing once the row is ticked', async () => {
    await renderPage(
      aListOf(
        [
          chicken({
            packs: { count: 3, size: 500, sizeUnit: 'g', quantity: 1500 },
            buyLater: [
              { packs: 1, from: '2026-01-07' },
              { packs: 1, from: '2026-01-10' },
            ],
          }),
        ],
        [],
      ),
    );
    expect(
      screen.getByText(spaced('Of these, buy 1 pack on Wednesday (Jan 7) at the earliest.')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(spaced('Of these, buy 1 pack on Saturday (Jan 10) at the earliest.')),
    ).toBeInTheDocument();
  });

  it('says what of the food stays in the freezer, which the list does not count', async () => {
    await renderPage(aListOf([chicken({ frozenKept: 220 })], []));

    expect(
      screen.getByText(spaced('220 g more stays in the freezer: the plan does not thaw it.')),
    ).toBeInTheDocument();
  });

  it("says whose pantry holds what is at home of a part's row that counts on another profile's", async () => {
    await renderPage(
      aListOf(
        [
          chicken({
            alreadyHaveQuantity: 150,
            pantries: [
              { profileId: '22222222-2222-4222-8222-222222222222', profile: 'Ewa', quantity: 50 },
              { profileId: '33333333-3333-4333-8333-333333333333', profile: 'Adam', quantity: 100 },
            ],
          }),
        ],
        [],
      ),
    );

    expect(plain(screen.getByText(/^From the pantry/).textContent)).toBe(
      'From the pantry: Ewa 50 g · Adam 100 g',
    );
  });

  it('names no pantry of a row that counts on its own alone', async () => {
    await renderPage(aListOf([chicken({ alreadyHaveQuantity: 150 })], []));

    expect(screen.queryByText(/From the pantry/)).toBeNull();
  });

  it('says nothing of the freezer where it keeps nothing of the food', async () => {
    await renderPage(aListOf([chicken()], []));

    expect(screen.queryByText(/stays in the freezer/)).toBeNull();
  });

  it('says nothing of when to buy a row that is ticked', async () => {
    await renderPage(aListOf([chicken({ checked: true, purchasedQuantity: 1000 })], []));

    expect(screen.queryByText(spaced(later))).toBeNull();
  });

  it('carries it into the copied text, under the row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(aListOf([chicken()], []));

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    const lines = String(writeText.mock.calls[0]![0])
      .replace(/[\u2009\u202f\u00a0]/g, ' ')
      .split('\n');
    expect(lines.slice(-2)).toEqual(['- Chicken breast: 300 g (2 × 500 g)', `  ${later}`]);
  });

  it('has a column for it in the table, there only where a row says it', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await renderPage(aListOf([chicken(), anEntry('White rice', 'grains')], []));

    await listOptions();
    await userEvent.click(screen.getByRole('button', { name: texts.csv }));

    const table = saved.mock.calls[0]![0].slice(1)
      .replace(/\u00a0/g, ' ')
      .split('\r\n');
    expect(table[0]!.split(',').at(-1)).toBe(texts.csvBuyLater);
    // A comma of the sentence puts it in quotes.
    expect(table[1]!.endsWith(`,"${later}"`)).toBe(true);
    expect(table[2]!.endsWith(',')).toBe(true);
  });
});

describe('a row of a shopping list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const atHome = () => screen.getByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) });
  const bought = () => screen.getByRole('spinbutton', { name: new RegExp(`^${texts.bought}`) });
  const pencil = (name: string) => screen.getByRole('button', { name: `Amounts of ${name}` });
  /** The page with a list of one row, opened, and what the row sends. */
  async function aRow(entry: Entry, answer: Entry = entry) {
    await renderPage(aListOf([entry], []));
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(aListOf([answer], []) as never);
    await userEvent.click(pencil(entry.name));
    return patch;
  }

  it('is its tick, its name, what is left to buy and a pencil that opens its two fields under it', async () => {
    await renderPage(aListOf([anEntry('White rice', 'grains')], []));

    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(pencil('White rice')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(pencil('White rice'));

    expect(pencil('White rice')).toHaveAttribute('aria-expanded', 'true');
    expect(atHome()).toBeInTheDocument();
    expect(bought()).toBeInTheDocument();
    await userEvent.click(pencil('White rice'));
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('says under the name, while it is closed, what is at home and what was bought', async () => {
    await renderPage(
      aListOf(
        [
          anEntry('White rice', 'grains', {
            alreadyHaveQuantity: 50,
            purchasedQuantity: 120,
            toBuyQuantity: 150,
          }),
          anEntry('Rolled oats', 'grains', { alreadyHaveQuantity: 30, purchasedQuantity: 30 }),
          anEntry('Barley', 'grains'),
        ],
        [],
      ),
    );
    const said = (name: string) =>
      plain(screen.getByRole('checkbox', { name }).closest('label')!.textContent);

    expect(said('White rice')).toBe('White riceat home 50 g · bought 70 g');
    expect(said('Rolled oats')).toBe('Rolled oatsat home 30 g');
    expect(said('Barley')).toBe('Barley');
    // Open, the row has them in its fields.
    await userEvent.click(pencil('White rice'));
    expect(said('White rice')).toBe('White rice');
  });

  it('keeps what is typed into one field while the server answers the other, and sends it once it is left', async () => {
    await renderPage(aListOf([anEntry('White rice', 'grains')], []));
    let answer!: (list: ShoppingList) => void;
    const patch = vi
      .spyOn(api, 'patch')
      .mockImplementationOnce(
        () => new Promise<ShoppingList>((resolve) => (answer = resolve)) as never,
      )
      .mockResolvedValue(aListOf([anEntry('White rice', 'grains')], []) as never);
    await userEvent.click(pencil('White rice'));

    await userEvent.type(atHome(), '50');
    // Leaving what is at home sends it; what was bought is typed in while that is answered.
    await userEvent.tab();
    await userEvent.type(bought(), '1');
    answer(
      aListOf(
        [anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 50 })],
        [],
      ),
    );
    await vi.waitFor(() =>
      expect(
        shownWith.getQueryData<ShoppingList[]>(['shopping-lists', PLAN])?.[0]?.groups[0]?.items[0]
          ?.alreadyHaveQuantity,
      ).toBe(50),
    );
    await userEvent.type(bought(), '00');

    expect(bought()).toHaveValue(100);
    expect(bought()).toHaveFocus();
    await userEvent.tab();
    expect(patch).toHaveBeenLastCalledWith(expect.any(String), { purchasedQuantity: 150 });
  });

  it('shows what is at home and what was bought as two numbers, and what is left to buy of the need', async () => {
    await aRow(
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 120,
        toBuyQuantity: 150,
      }),
    );

    expect(atHome()).toHaveValue(50);
    expect(bought()).toHaveValue(70);
    expect(screen.getByText('80 g')).toBeInTheDocument();
    expect(screen.getByText('(of 200 g)')).toBeInTheDocument();
  });

  it('leaves both fields empty on a row nobody has anything for', async () => {
    await aRow(anEntry('White rice', 'grains'));

    expect(atHome()).toHaveValue(null);
    expect(bought()).toHaveValue(null);
    expect(screen.queryByText('(of 200 g)')).toBeNull();
  });

  it("stays open when the server's answer draws it anew, with what the server has", async () => {
    const patch = await aRow(
      anEntry('White rice', 'grains'),
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 80,
        purchasedQuantity: 80,
        toBuyQuantity: 120,
      }),
    );

    await userEvent.type(atHome(), '80');
    await userEvent.tab();

    await vi.waitFor(() => expect(patch).toHaveBeenCalled());
    await vi.waitFor(() => expect(atHome()).toHaveValue(80));
    expect(pencil('White rice')).toHaveAttribute('aria-expanded', 'true');
  });

  it('sends what the user says is at home when the field is left, and follows it while it is typed', async () => {
    const patch = await aRow(anEntry('White rice', 'grains'));

    await userEvent.type(atHome(), '80');
    expect(screen.getByText('120 g')).toBeInTheDocument();
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/items\/entry-White rice$/), {
      alreadyHaveQuantity: 80,
    });
  });

  it('sends nothing at home for a field that is emptied', async () => {
    const patch = await aRow(
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 50,
        toBuyQuantity: 150,
      }),
    );

    await userEvent.clear(atHome());
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.any(String), { alreadyHaveQuantity: 0 });
  });

  it('sends what was bought as everything the user has for the row: the part at home with it', async () => {
    const patch = await aRow(
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 50,
        toBuyQuantity: 150,
      }),
    );

    await userEvent.type(bought(), '100');
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.any(String), { purchasedQuantity: 150 });
  });

  it('sends nothing when a field is left as it was', async () => {
    const patch = await aRow(
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 120,
        toBuyQuantity: 150,
      }),
    );

    await userEvent.click(atHome());
    await userEvent.tab();
    await userEvent.tab();

    expect(patch).not.toHaveBeenCalled();
  });

  it('sends what was typed along with a tick, in one request', async () => {
    const patch = await aRow(anEntry('White rice', 'grains'));

    await userEvent.type(atHome(), '80');
    // The box is clicked while the field still has the focus: the field is left by the same click.
    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }));

    expect(patch.mock.calls.map(([, body]) => body)).toContainEqual({
      checked: true,
      alreadyHaveQuantity: 80,
    });
  });

  describe('of fresh meat or fish sold in packs, bought by weight', () => {
    const loose = () => screen.getByRole('checkbox', { name: texts.boughtLooseBox });
    const chicken = (over: Partial<Entry> = {}) =>
      anEntry('Chicken breast', 'meat', {
        totalQuantity: 450,
        toBuyQuantity: 450,
        packs: { count: 1, size: 500, sizeUnit: 'g', quantity: 500 },
        byWeight: true,
        ...over,
      });

    it('is said with what was bought, once its field is left, and says what the plan does with it', async () => {
      const patch = await aRow(chicken());

      expect(loose()).not.toBeChecked();
      expect(loose()).toHaveAccessibleDescription(texts.boughtLooseHint);
      // Ticked before anything is bought: it goes with what is bought.
      await userEvent.click(loose());
      expect(patch).not.toHaveBeenCalled();
      await userEvent.type(bought(), '1000');
      await userEvent.tab();

      expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/items\/entry-Chicken breast$/), {
        boughtLoose: true,
        purchasedQuantity: 1000,
      });
    });

    it('is said at once of what was bought already, and taken back the same way', async () => {
      const bought = chicken({ purchasedQuantity: 1000, checked: true, packs: null });
      const patch = await aRow(bought, { ...bought, boughtLooseOn: '2026-01-05' });

      await userEvent.click(loose());
      expect(patch).toHaveBeenLastCalledWith(expect.any(String), { boughtLoose: true });
      await vi.waitFor(() => expect(loose()).toBeChecked());

      patch.mockResolvedValue(aListOf([bought], []) as never);
      await userEvent.click(loose());
      expect(patch).toHaveBeenLastCalledWith(expect.any(String), { boughtLoose: false });
    });

    it('says, closed, that what was bought was bought by weight', async () => {
      await renderPage(
        aListOf(
          [
            chicken({
              purchasedQuantity: 1000,
              checked: true,
              packs: null,
              boughtLooseOn: '2026-01-05',
            }),
          ],
          [],
        ),
      );

      expect(
        plain(
          screen.getByRole('checkbox', { name: 'Chicken breast' }).closest('label')!.textContent,
        ),
      ).toBe('Chicken breastbought by weight 1000 g');
    });

    it('is offered for no other row', async () => {
      await aRow(anEntry('Tinned tuna', 'fish', { packs: TWO_PACKS }));

      expect(screen.queryByRole('checkbox', { name: texts.boughtLooseBox })).toBeNull();
      expect(screen.queryByText(texts.boughtLooseHint)).toBeNull();
    });
  });

  describe('of something sold in packs', () => {
    const packsOf = (name: string) =>
      screen.queryByRole('button', { name: new RegExp(`^Bought in packs: .* of ${name}$`) });

    it('says how many packs what is left to buy comes to, and what pressing that does', async () => {
      await aRow(
        anEntry('Salmon', 'grains', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }),
      );

      expect(packsOf('Salmon')).toHaveTextContent('2 × 250 g');
      expect(packsOf('Salmon')).toHaveAccessibleName(
        spaced('Bought in packs: 2 × 250 g of Salmon'),
      );
      // What pressing it does is said behind "How it works", above the rows.
      const hint = screen.getByText(texts.packsHint).closest('details')!;
      expect(hint).not.toHaveAttribute('open');
      expect(within(hint).getByText(texts.howItWorks).tagName).toBe('SUMMARY');
    });

    it('takes whoever presses it to have what was at home and what the packs hold, and the row for done', async () => {
      const patch = await aRow(
        anEntry('Large egg', 'grains', {
          totalQuantity: 6,
          unit: 'piece',
          displayUnit: 'piece',
          alreadyHaveQuantity: 2,
          purchasedQuantity: 2,
          toBuyQuantity: 4,
          packs: { count: 1, size: 10, sizeUnit: 'piece', quantity: 10 },
        }),
      );

      await userEvent.click(packsOf('Large egg')!);

      expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/items\/entry-Large egg$/), {
        purchasedQuantity: 12,
        checked: true,
      });
    });

    it('says nothing of packs on a row that is not sold in them, and nothing of what pressing does on a list without one', async () => {
      await aRow(anEntry('Broccoli', 'grains'));

      expect(screen.queryByRole('button', { name: /^Bought in packs/ })).toBeNull();
      expect(screen.queryByText(texts.packsHint)).toBeNull();
      expect(screen.queryByText(texts.howItWorks)).toBeNull();
    });

    it('says nothing of packs on a row that is ticked, or of which a part was bought', async () => {
      await renderPage(
        aListOf(
          [
            anEntry('Salmon', 'grains', {
              totalQuantity: 435,
              toBuyQuantity: 435,
              purchasedQuantity: 435,
              checked: true,
              packs: TWO_PACKS,
            }),
          ],
          [
            anEntry('Cod', 'vegetables', {
              totalQuantity: 435,
              toBuyQuantity: 435,
              purchasedQuantity: 100,
              packs: TWO_PACKS,
            }),
          ],
        ),
      );

      expect(screen.queryByRole('button', { name: /^Bought in packs/ })).toBeNull();
    });

    it('waits for the answer to a change of the list before it can be pressed: the server counts the packs', async () => {
      await renderPage(
        aListOf(
          [
            anEntry('Salmon', 'grains', {
              totalQuantity: 435,
              toBuyQuantity: 435,
              packs: TWO_PACKS,
            }),
          ],
          [anEntry('Broccoli', 'vegetables')],
        ),
      );
      let give!: (list: ShoppingList) => void;
      vi.spyOn(api, 'patch').mockReturnValue(
        new Promise<ShoppingList>((resolve) => (give = resolve)) as never,
      );

      await userEvent.click(screen.getByRole('checkbox', { name: 'Broccoli' }));

      expect(packsOf('Salmon')).toBeDisabled();
      give(
        aListOf(
          [
            anEntry('Salmon', 'grains', {
              totalQuantity: 435,
              toBuyQuantity: 435,
              packs: TWO_PACKS,
            }),
          ],
          [anEntry('Broccoli', 'vegetables', { checked: true })],
        ),
      );
      await vi.waitFor(() => expect(packsOf('Salmon')).toBeEnabled());
    });

    it('takes the packs back while what is at home is typed anew: the server counts them from that', async () => {
      await aRow(
        anEntry('Salmon', 'grains', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }),
      );

      await userEvent.type(atHome(), '200');

      expect(packsOf('Salmon')).toBeNull();
    });
  });

  it('says until when what the pantry held for the row is good', async () => {
    await aRow(
      anEntry('White rice', 'grains', {
        alreadyHaveQuantity: 50,
        purchasedQuantity: 50,
        toBuyQuantity: 150,
        pantryBestBefore: '2026-02-01',
      }),
    );

    expect(screen.getByText('best before Feb 1, 2026')).toBeInTheDocument();
  });
});

describe('a tick on a row of a shopping list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const box = (name: string) => screen.getByRole('checkbox', { name });
  const ticked = (list: ShoppingList, ...names: string[]): ShoppingList => ({
    ...list,
    groups: list.groups.map((group) => ({
      ...group,
      items: group.items.map((entry) =>
        names.includes(entry.name) ? { ...entry, checked: true } : entry,
      ),
    })),
  });
  /** A request whose answer the test gives when it chooses to. */
  function anAnswerToGive() {
    let give!: (list: ShoppingList) => void;
    let refuse!: (error: unknown) => void;
    const answer = new Promise<ShoppingList>((resolve, reject) => {
      give = resolve;
      refuse = reject;
    });
    return { answer, give, refuse };
  }

  it('is shown at once, and the other rows can be ticked while the server has not answered', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Amounts of Rolled oats' }));
    const first = anAnswerToGive();
    const patch = vi.spyOn(api, 'patch').mockReturnValue(first.answer as never);

    await userEvent.click(box('White rice'));

    expect(box('White rice')).toBeChecked();
    expect(patch).toHaveBeenCalledWith(`/shopping-lists/${aList.id}/items/entry-White rice`, {
      checked: true,
    });
    expect(box('Rolled oats')).toBeEnabled();
    expect(box('Broccoli')).toBeEnabled();
    // So can a row's amounts be typed in: a field being typed in takes no answer of the server.
    expect(screen.getByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) })).toBeEnabled();

    first.give(ticked(aList, 'White rice'));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(box('White rice')).toBeChecked();
  });

  it('is taken back when the server refuses it, and the page says so', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(
      new ApiClientError(409, 'CONFLICT', 'That already exists.'),
    );

    await userEvent.click(box('White rice'));

    expect(await screen.findByText(messages.errors.CONFLICT)).toBeInTheDocument();
    expect(box('White rice')).not.toBeChecked();
    expect(box('Rolled oats')).not.toBeChecked();
  });

  it('stays shown beside a second one whose answer comes first, and the list is read from the server once both are through', async () => {
    const get = await renderPage().then(() => vi.mocked(api.get));
    const [rice, oats] = [anAnswerToGive(), anAnswerToGive()];
    vi.spyOn(api, 'patch').mockImplementation(((path: string) =>
      path.endsWith('White rice') ? rice.answer : oats.answer) as never);

    await userEvent.click(box('White rice'));
    await userEvent.click(box('Rolled oats'));
    expect(box('White rice')).toBeChecked();
    expect(box('Rolled oats')).toBeChecked();

    // The answer to the second tick was made before the server had the first: it knows of one tick only.
    const readBefore = get.mock.calls.filter(([path]) =>
      String(path).startsWith('/shopping-lists?'),
    ).length;
    oats.give(ticked(aList, 'Rolled oats'));
    await Promise.resolve();
    expect(box('White rice')).toBeChecked();

    rice.give(ticked(aList, 'White rice'));
    await vi.waitFor(() =>
      expect(
        get.mock.calls.filter(([path]) => String(path).startsWith('/shopping-lists?')).length,
      ).toBeGreaterThan(readBefore),
    );
  });
});

describe('a row of a shopping list, while the server cannot be reached', () => {
  const noAnswer = new ApiClientError(0, 'NETWORK', 'Cannot reach the server.');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says that the row could not be changed, and shows its tick as the server has it', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }));

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'White rice' })).not.toBeChecked();
  });

  it('says the same of a quantity', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    await userEvent.click(screen.getByRole('button', { name: 'Amounts of White rice' }));
    const atHome = screen.getByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) });
    await userEvent.type(atHome, '80');
    await userEvent.tab();

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
  });
});

describe('the shopping page with nothing to show yet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The page of an account with these profiles, plans and lists. */
  function renderWith({
    profiles = [{ id: 'profile', name: 'Me' }],
    plans = [] as unknown[],
    lists = [] as ShoppingList[],
    households = [] as unknown[],
  }) {
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      Promise.resolve(
        (path === '/profiles'
          ? profiles
          : path === '/household-lists'
            ? households
            : path === '/users/me'
              ? { aiMode: 'none' }
              : path.startsWith('/meal-plans?')
                ? { items: plans, page: 1, pageSize: 50, total: plans.length, totalPages: 1 }
                : path.startsWith('/shopping-lists?')
                  ? lists
                  : []) as never,
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['config'], aPublicConfig());
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <ShoppingListsPage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
  }

  it("says of a plan's list that it is a part of a household list, and opens the whole", async () => {
    const part = (planId: string, profile: string) => ({
      listId: `list-${profile}`,
      planId,
      profileId: profile,
      profile,
      fromDate: '2026-01-05',
      toDate: '2026-01-07',
      stale: false,
    });
    renderWith({
      profiles: [
        { id: 'profile', name: 'Me' },
        { id: 'other', name: 'Ewa' },
      ],
      plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }],
      lists: [{ ...aList, household: { id: 'household', profiles: ['Ewa', 'Me'] } }],
      households: [
        {
          id: 'household',
          fromDate: '2026-01-05',
          toDate: '2026-01-07',
          parts: [part('ewas-plan', 'Ewa'), part(PLAN, 'Me')],
          groups: [],
          totalEstimatedCalories: 0,
          stale: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(
      await screen.findByText(
        "This list is a part of a household list: Ewa and Me. A tick here changes this plan's part only.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('For: Ewa and Me')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.openHousehold }));
    expect(await screen.findByText('For: Ewa and Me')).toBeInTheDocument();
  });

  it('says that a new list of the days of a part takes its place in the household list, and not of other days', async () => {
    renderWith({
      profiles: [
        { id: 'profile', name: 'Me' },
        { id: 'other', name: 'Ewa' },
      ],
      plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }],
      lists: [
        {
          ...aList,
          fromDate: '2026-01-06',
          toDate: '2026-01-07',
          household: { id: 'household', profiles: ['Ewa', 'Me'] },
        },
      ],
    });
    const replaces =
      "A list of these days is a part of a household list: Ewa and Me. A new list takes its place, and the household list loses this plan's part.";

    await userEvent.click(await screen.findByRole('button', { name: texts.generate }));
    expect(screen.getByText(replaces)).toBeVisible();
    const [from, to] = screen.getAllByLabelText(/^(From|To)/);
    fireEvent.change(to!, { target: { value: '2026-01-05' } });
    fireEvent.change(from!, { target: { value: '2026-01-05' } });
    expect(screen.queryByText(replaces)).not.toBeInTheDocument();
  });

  it('leads an account without a profile to the profiles', async () => {
    renderWith({ profiles: [] });

    expect(await screen.findByRole('heading', { name: texts.noProfile })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.noProfileCta })).toHaveAttribute(
      'href',
      '/profile',
    );
  });

  it('says that a list is made from a plan where the profile has none, and leads to the plans: there is no form to fill in', async () => {
    renderWith({});

    expect(await screen.findByRole('heading', { name: texts.noPlansTitle })).toBeInTheDocument();
    expect(screen.getByText(texts.noPlans)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.noPlansCta })).toHaveAttribute(
      'href',
      '/meal-plans',
    );
    expect(screen.queryByRole('button', { name: texts.generateButton })).not.toBeInTheDocument();
  });

  it('offers the list of a plan that has none, and makes it with what the form names', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aList as never);
    renderWith({
      plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }],
    });

    expect(await screen.findByRole('heading', { name: texts.noListsTitle })).toBeInTheDocument();
    expect(screen.getByText(texts.noLists)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.noListsCta }));

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledExactlyOnceWith('/shopping-lists/generate', {
        planId: PLAN,
        fromDate: '2026-01-05',
        toDate: '2026-01-07',
      }),
    );
  });

  it('asks which plan over the list where the profile has two or more, the newest chosen', async () => {
    renderWith({
      plans: [
        { id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' },
        { id: 'older-plan', startDate: '2025-12-29', durationDays: 7, dietType: 'vegan' },
      ],
      lists: [aList],
    });

    const plan = await screen.findByRole('combobox', { name: texts.plan });
    expect(plan).toHaveValue(PLAN);
    expect(within(plan).getAllByRole('option')).toHaveLength(2);
    const firstRow = await screen.findByRole('checkbox', { name: 'White rice' });
    expect(plan.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has the form a list is made with open while the plan has no list', async () => {
    renderWith({
      plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }],
    });

    await screen.findByRole('heading', { name: texts.noListsTitle });
    expect(screen.getByRole('button', { name: texts.generate })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: texts.generateButton })).toBeVisible();
  });

  it('says in the form, opened for it, why a list could not be made', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiClientError(0, 'NETWORK', 'Failed to fetch'));
    renderWith({
      plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }],
    });
    const head = await screen.findByRole('button', { name: texts.generate });
    // Folded by the user, then sent by the button of the empty list.
    await userEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: texts.noListsCta }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(head).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the shopping page with a list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the list first, and the form for another list folded under it', async () => {
    await renderPage();
    const head = screen.getByRole('button', { name: texts.generate });
    const firstRow = screen.getByRole('checkbox', { name: 'White rice' });

    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', { name: texts.generateButton, hidden: true }),
    ).not.toBeVisible();
    expect(firstRow.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A profile of one plan is not asked which.
    expect(screen.queryByRole('combobox', { name: texts.plan })).toBeNull();

    await userEvent.click(head);
    expect(screen.getByRole('button', { name: texts.generateButton })).toBeVisible();
  });

  it('has what can be done with the list behind one button beside the magnifier', async () => {
    await renderPage();
    const options = screen.getByRole('button', { name: texts.listOptions });

    expect(options).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: texts.copy })).toBeNull();

    await listOptions();

    expect(options).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: texts.listOptions });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([texts.printNotebook, texts.printPdf, texts.copy, texts.csv, messages.common.delete]);
  });

  it('asks what the list could do without under its rows, after the last aisle', async () => {
    await renderPage();
    const ask = await screen.findByRole('button', { name: texts.proposals.ask });
    const lastRow = screen.getByRole('checkbox', { name: 'Broccoli' });

    expect(lastRow.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the shopping list read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the list it showed when a read fails again, says why above it, and reads again when asked', async () => {
    await renderPage();
    const before = entries();

    const answerAgain = await failReadsAgain(shownWith);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(entries()).toEqual(before);
    answerAgain();
    await userEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: messages.common.retry,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
    expect(entries()).toEqual(before);
  });
});

describe('the shopping lists, when they cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failing(path: (asked: string) => boolean) {
    vi.spyOn(api, 'get').mockImplementation((asked: string) =>
      path(asked)
        ? Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch'))
        : Promise.resolve(
            (asked === '/profiles'
              ? [{ id: 'profile', name: 'Me' }]
              : asked === '/users/me'
                ? { aiMode: 'none' }
                : asked.startsWith('/meal-plans?')
                  ? {
                      items: [
                        {
                          id: PLAN,
                          startDate: '2026-01-05',
                          durationDays: 3,
                          dietType: 'balanced',
                        },
                      ],
                      page: 1,
                      pageSize: 50,
                      total: 1,
                      totalPages: 1,
                    }
                  : []) as never,
          ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['config'], aPublicConfig());
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <ShoppingListsPage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
  }

  it('says why, and not that the plan has no list', async () => {
    failing((asked) => asked.startsWith('/shopping-lists?'));

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
    expect(screen.queryByText(texts.noListsTitle)).toBeNull();
  });

  it('says why, and not that there is no plan to make a list from', async () => {
    failing((asked) => asked.startsWith('/meal-plans?'));

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
    expect(screen.queryByText(texts.noPlansTitle)).toBeNull();
  });
});
