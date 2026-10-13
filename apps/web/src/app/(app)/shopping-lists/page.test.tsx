// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingList } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { offline } from '@/lib/offline';
import * as files from '@/lib/save-file';
import { aCacheStorage } from '@/testing/cache-storage';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import ShoppingListsPage from './page';

const texts = messages.shoppingLists;
const PLAN = '11111111-1111-4111-8111-111111111111';

type Entry = ShoppingList['groups'][number]['items'][number];

const anEntry = (name: string, category: Entry['category'], over: Partial<Entry> = {}): Entry => ({
  id: `entry-${name}`,
  ingredientId: `ingredient-${name}`,
  name,
  category,
  totalQuantity: 200,
  unit: 'g',
  displayUnit: 'g',
  alreadyHaveQuantity: 0,
  toBuyQuantity: 200,
  purchasedQuantity: null,
  pantryBestBefore: null,
  estimatedCalories: 400,
  packs: null,
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
    { category: 'grains', items: grains, estimatedCalories: grains.reduce((sum, entry) => sum + entry.estimatedCalories, 0) },
    { category: 'vegetables', items: vegetables, estimatedCalories: vegetables.reduce((sum, entry) => sum + entry.estimatedCalories, 0) },
  ],
  totalEstimatedCalories: [...grains, ...vegetables].reduce((sum, entry) => sum + entry.estimatedCalories, 0),
  stale: false,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const aList = aListOf([anEntry('White rice', 'grains'), anEntry('Rolled oats', 'grains')], [anEntry('Broccoli', 'vegetables')]);

async function renderPage(list: ShoppingList = aList, aiMode: 'none' | 'admin' = 'none') {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles'
        ? [{ id: 'profile', name: 'Me' }]
        : path === '/users/me'
          ? { aiMode }
        : path.startsWith('/meal-plans?')
          ? { items: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }], page: 1, pageSize: 50, total: 1, totalPages: 1 }
          : path.startsWith('/shopping-lists?')
            ? [list]
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
  return screen.findByLabelText(texts.findEntry);
}

/** The entries on screen, by the name each is ticked by. */
const entries = (): string[] => screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label') ?? '');

describe('a shopping list, looked through for an entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every entry under its aisle until something is looked for', async () => {
    await renderPage();

    expect(entries()).toEqual(['White rice', 'Rolled oats', 'Broccoli']);
    expect(screen.getAllByRole('heading', { level: 3 }).map((aisle) => aisle.textContent)).toEqual(expect.arrayContaining(['Grains', 'Vegetables']));
  });

  it('keeps the entries whose name holds the words, whatever their case, and the aisles that still have one', async () => {
    const find = await renderPage();

    await userEvent.type(find, 'RIC');

    expect(entries()).toEqual(['White rice']);
    expect(screen.queryByText('Vegetables')).toBeNull();

    await userEvent.clear(find);
    expect(entries()).toHaveLength(3);
  });

  it('says so when no entry has the words in its name', async () => {
    const find = await renderPage();

    await userEvent.type(find, 'salmon');

    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('No entry of this list has “salmon” in its name.')).toBeInTheDocument();
  });
});

describe('a shopping list, looked over for what it could do without', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const texts = messages.shoppingLists.proposals;
  const leftover = { kind: 'leftover', ingredientId: 'beef', name: 'Ground beef', unit: 'g', left: 320, packSize: 500, reason: null } as const;

  it('is asked of the API for the list that is shown, and what comes back leads to the plan of the profile', async () => {
    await renderPage();
    const post = vi.spyOn(api, 'post').mockResolvedValue({ planId: PLAN, proposals: [leftover], aiMeta: null } as never);

    await userEvent.click(screen.getByRole('button', { name: texts.ask }));

    expect(post).toHaveBeenCalledWith(`/shopping-lists/${aList.id}/proposals`, { weigh: false });
    expect(await screen.findByRole('link', { name: texts.leftoverHow })).toHaveAttribute('href', `/meal-plans?profile=profile&plan=${PLAN}&day=2026-01-05`);
  });

  it('says beside it, on an account with AI off, why no model can be asked', async () => {
    await renderPage();

    expect(await screen.findByText(/AI is turned off for this account/)).toBeInTheDocument();
  });

  it('says nothing of that on an account that has a model to ask', async () => {
    await renderPage(aList, 'admin');
    await screen.findByRole('button', { name: texts.ask });

    await vi.waitFor(() => expect(screen.queryByText(/AI is turned off for this account/)).toBeNull());
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
    [anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 50, toBuyQuantity: 150 }), anEntry('Rolled oats', 'grains', { purchasedQuantity: 200, checked: true })],
    [anEntry('Broccoli', 'vegetables', { name: '=Broccoli' })],
  );

  /** The lines of the text that was put on the clipboard. A language may write a range of days with spaces narrower than the one of a keyboard. */
  const copiedBy = (writeText: ReturnType<typeof vi.fn>): string[] => String(writeText.mock.calls[0]![0]).replace(/[\u2009\u202f\u00a0]/g, ' ').split('\n');

  it('is copied as a text of what is still to buy, under its aisles, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(underWay);

    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText)).toEqual(['Shopping list, Jan 5 – 7, 2026', '', 'Grains', '- White rice: 150 g', '', 'Vegetables', '- =Broccoli: 200 g']);
    expect(await screen.findByText('Copied: 2 entries still to buy, under their aisles.')).toBeInTheDocument();
  });

  it('is shown to be copied by hand where the browser gives the page no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    await renderPage(underWay);

    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    const byHand = within(await screen.findByRole('dialog', { name: texts.copyByHand }));
    expect(byHand.getByText(texts.copyByHandHint)).toBeInTheDocument();
    expect((byHand.getByRole('textbox', { name: texts.copyByHand }) as HTMLTextAreaElement).value).toContain('- White rice: 150 g');
  });

  it('says that nothing is left to buy of a list that is all ticked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(aListOf([anEntry('White rice', 'grains', { purchasedQuantity: 200, checked: true })], []));

    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText)).toEqual(['Shopping list, Jan 5 – 7, 2026', '', texts.copyNothing]);
    expect(await screen.findByText(texts.copiedNothing)).toBeInTheDocument();
  });

  it('is saved as a table of every row, with its numbers as numbers and no name that a spreadsheet would work out', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await renderPage(underWay);

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
    [anEntry('Wholegrain bread', 'grains', { totalQuantity: 8, unit: 'piece', displayUnit: 'slice', purchasedQuantity: 3, toBuyQuantity: 8, packs: { count: 1, size: 500, sizeUnit: 'g', quantity: 14 } })],
    [
      anEntry('Salmon', 'vegetables', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }),
      anEntry('Large egg', 'vegetables', { totalQuantity: 6, unit: 'piece', displayUnit: 'piece', alreadyHaveQuantity: 2, purchasedQuantity: 2, toBuyQuantity: 4, packs: { count: 1, size: 10, sizeUnit: 'piece', quantity: 10 } }),
    ],
  );

  it('says in the text how many packs a row takes, for a row of which nothing was bought yet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage(inPacks);

    await userEvent.click(screen.getByRole('button', { name: texts.copy }));

    expect(copiedBy(writeText).slice(2)).toEqual(['Grains', '- Wholegrain bread: 5 slices', '', 'Vegetables', '- Salmon: 435 g (2 × 250 g)', '- Large egg: 4 pieces (1 × 10 pieces)']);
  });

  it('has a column for the packs in the table', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await renderPage(inPacks);

    await userEvent.click(screen.getByRole('button', { name: texts.csv }));

    expect(saved.mock.calls[0]![0].slice(1).split('\r\n').slice(1, 4)).toEqual([
      'Grains,Wholegrain bread,8,slices,0,3,5,,No,400',
      'Vegetables,Salmon,435,g,0,0,435,2 × 250 g,No,400',
      'Vegetables,Large egg,6,pieces,2,2,4,1 × 10 pieces,No,400',
    ]);
  });
});

describe('a row of a shopping list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const atHome = () => screen.getByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) });
  const bought = () => screen.getByRole('spinbutton', { name: new RegExp(`^${texts.bought}`) });
  /** The page with a list of one row, and what the row sends. */
  async function aRow(entry: Entry) {
    await renderPage(aListOf([entry], []));
    return vi.spyOn(api, 'patch').mockResolvedValue(aListOf([entry], []) as never);
  }

  it('shows what is at home and what was bought as two numbers, and what is left to buy of the need', async () => {
    await aRow(anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 120, toBuyQuantity: 150 }));

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

  it('sends what the user says is at home when the field is left, and follows it while it is typed', async () => {
    const patch = await aRow(anEntry('White rice', 'grains'));

    await userEvent.type(atHome(), '80');
    expect(screen.getByText('120 g')).toBeInTheDocument();
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/items\/entry-White rice$/), { alreadyHaveQuantity: 80 });
  });

  it('sends nothing at home for a field that is emptied', async () => {
    const patch = await aRow(anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 50, toBuyQuantity: 150 }));

    await userEvent.clear(atHome());
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.any(String), { alreadyHaveQuantity: 0 });
  });

  it('sends what was bought as everything the user has for the row: the part at home with it', async () => {
    const patch = await aRow(anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 50, toBuyQuantity: 150 }));

    await userEvent.type(bought(), '100');
    await userEvent.tab();

    expect(patch).toHaveBeenCalledWith(expect.any(String), { purchasedQuantity: 150 });
  });

  it('sends nothing when a field is left as it was', async () => {
    const patch = await aRow(anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 120, toBuyQuantity: 150 }));

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

    expect(patch.mock.calls.map(([, body]) => body)).toContainEqual({ checked: true, alreadyHaveQuantity: 80 });
  });

  describe('of something sold in packs', () => {
    const packsOf = (name: string) => screen.queryByRole('button', { name: new RegExp(`^Bought in packs: .* of ${name}$`) });

    it('says how many packs what is left to buy comes to, and what pressing that does', async () => {
      await aRow(anEntry('Salmon', 'grains', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }));

      expect(packsOf('Salmon')).toHaveTextContent('2 × 250 g');
      expect(packsOf('Salmon')).toHaveAccessibleName('Bought in packs: 2 × 250 g of Salmon');
      expect(screen.getByText(texts.packsHint)).toBeInTheDocument();
    });

    it('takes whoever presses it to have what was at home and what the packs hold, and the row for done', async () => {
      const patch = await aRow(anEntry('Large egg', 'grains', { totalQuantity: 6, unit: 'piece', displayUnit: 'piece', alreadyHaveQuantity: 2, purchasedQuantity: 2, toBuyQuantity: 4, packs: { count: 1, size: 10, sizeUnit: 'piece', quantity: 10 } }));

      await userEvent.click(packsOf('Large egg')!);

      expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/items\/entry-Large egg$/), { purchasedQuantity: 12, checked: true });
    });

    it('says nothing of packs on a row that is not sold in them, and nothing of what pressing does on a list without one', async () => {
      await aRow(anEntry('Broccoli', 'grains'));

      expect(screen.queryByRole('button', { name: /^Bought in packs/ })).toBeNull();
      expect(screen.queryByText(texts.packsHint)).toBeNull();
    });

    it('says nothing of packs on a row that is ticked, or of which a part was bought', async () => {
      await renderPage(
        aListOf(
          [anEntry('Salmon', 'grains', { totalQuantity: 435, toBuyQuantity: 435, purchasedQuantity: 435, checked: true, packs: TWO_PACKS })],
          [anEntry('Cod', 'vegetables', { totalQuantity: 435, toBuyQuantity: 435, purchasedQuantity: 100, packs: TWO_PACKS })],
        ),
      );

      expect(screen.queryByRole('button', { name: /^Bought in packs/ })).toBeNull();
    });

    it('takes the packs back while what is at home is typed anew: the server counts them from that', async () => {
      await aRow(anEntry('Salmon', 'grains', { totalQuantity: 435, toBuyQuantity: 435, packs: TWO_PACKS }));

      await userEvent.type(atHome(), '200');

      expect(packsOf('Salmon')).toBeNull();
    });
  });

  it('says until when what the pantry held for the row is good', async () => {
    await aRow(anEntry('White rice', 'grains', { alreadyHaveQuantity: 50, purchasedQuantity: 50, toBuyQuantity: 150, pantryBestBefore: '2026-02-01' }));

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
    groups: list.groups.map((group) => ({ ...group, items: group.items.map((entry) => (names.includes(entry.name) ? { ...entry, checked: true } : entry)) })),
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
    const first = anAnswerToGive();
    const patch = vi.spyOn(api, 'patch').mockReturnValue(first.answer as never);

    await userEvent.click(box('White rice'));

    expect(box('White rice')).toBeChecked();
    expect(patch).toHaveBeenCalledWith(`/shopping-lists/${aList.id}/items/entry-White rice`, { checked: true });
    expect(box('Rolled oats')).toBeEnabled();
    expect(box('Broccoli')).toBeEnabled();
    // What the server works out of a row waits for its answer.
    expect(screen.getAllByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) })[0]).toBeDisabled();

    first.give(ticked(aList, 'White rice'));
    await vi.waitFor(() => expect(screen.getAllByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) })[0]).toBeEnabled());
    expect(box('White rice')).toBeChecked();
  });

  it('is taken back when the server refuses it, and the page says so', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(new ApiClientError(409, 'CONFLICT', 'That already exists.'));

    await userEvent.click(box('White rice'));

    expect(await screen.findByText(messages.errors.CONFLICT)).toBeInTheDocument();
    expect(box('White rice')).not.toBeChecked();
    expect(box('Rolled oats')).not.toBeChecked();
  });

  it('stays shown beside a second one whose answer comes first, and the list is read from the server once both are through', async () => {
    const get = await renderPage().then(() => vi.mocked(api.get));
    const [rice, oats] = [anAnswerToGive(), anAnswerToGive()];
    vi.spyOn(api, 'patch').mockImplementation(((path: string) => (path.endsWith('White rice') ? rice.answer : oats.answer)) as never);

    await userEvent.click(box('White rice'));
    await userEvent.click(box('Rolled oats'));
    expect(box('White rice')).toBeChecked();
    expect(box('Rolled oats')).toBeChecked();

    // The answer to the second tick was made before the server had the first: it knows of one tick only.
    const readBefore = get.mock.calls.filter(([path]) => String(path).startsWith('/shopping-lists?')).length;
    oats.give(ticked(aList, 'Rolled oats'));
    await Promise.resolve();
    expect(box('White rice')).toBeChecked();

    rice.give(ticked(aList, 'White rice'));
    await vi.waitFor(() => expect(get.mock.calls.filter(([path]) => String(path).startsWith('/shopping-lists?')).length).toBeGreaterThan(readBefore));
  });
});

describe('a row of a shopping list, while the server cannot be reached', () => {
  const ACCOUNT = '99999999-9999-4999-8999-999999999999';
  const noAnswer = new ApiClientError(0, 'NETWORK', 'Cannot reach the server.');

  beforeEach(async () => {
    vi.stubGlobal('caches', aCacheStorage());
    localStorage.clear();
    await offline.belongsTo(ACCOUNT);
  });

  afterEach(async () => {
    await offline.forget();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('keeps a tick for when the server is back, and shows it at once', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }));

    await vi.waitFor(() => expect(offline.waiting).toEqual([{ listId: aList.id, itemId: 'entry-White rice', checked: true }]));
    expect(screen.getByRole('checkbox', { name: 'White rice' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rolled oats' })).not.toBeChecked();
    expect(screen.queryByText(texts.errUpdate)).toBeNull();
    // The list as it is shown is what a page loaded next will find.
    const kept = await offline.recall<ShoppingList[]>(`/shopping-lists?planId=${PLAN}`);
    expect(kept.found && kept.answer[0]!.groups[0]!.items.find((entry) => entry.name === 'White rice')!.checked).toBe(true);
  });

  it('takes a tick back the same way', async () => {
    await renderPage(aListOf([anEntry('White rice', 'grains', { purchasedQuantity: 200, checked: true })], []));
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }));

    await vi.waitFor(() => expect(offline.waiting).toEqual([{ listId: aList.id, itemId: 'entry-White rice', checked: false }]));
    expect(screen.getByRole('checkbox', { name: 'White rice' })).not.toBeChecked();
  });

  it('says of a quantity that it can be changed when the server is back, and keeps nothing of it', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    const atHome = screen.getAllByRole('spinbutton', { name: new RegExp(`^${texts.atHome}`) })[0]!;
    await userEvent.type(atHome, '80');
    await userEvent.tab();

    expect(await screen.findByText(messages.offline.onlyTicks)).toBeInTheDocument();
    expect(offline.waiting).toEqual([]);
  });

  it('says that the row could not be changed where the browser keeps nothing', async () => {
    await offline.forget();
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(noAnswer);

    await userEvent.click(screen.getByRole('checkbox', { name: 'White rice' }));

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'White rice' })).not.toBeChecked();
  });
});

describe('the shopping page with nothing to show yet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The page of an account with these profiles, plans and lists. */
  function renderWith({ profiles = [{ id: 'profile', name: 'Me' }], plans = [] as unknown[], lists = [] as ShoppingList[] }) {
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      Promise.resolve(
        (path === '/profiles'
          ? profiles
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

  it('leads an account without a profile to the profiles', async () => {
    renderWith({ profiles: [] });

    expect(await screen.findByRole('heading', { name: texts.noProfile })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.noProfileCta })).toHaveAttribute('href', '/profile');
  });

  it('says that a list is made from a plan where the profile has none, and leads to the plans: there is no form to fill in', async () => {
    renderWith({});

    expect(await screen.findByRole('heading', { name: texts.noPlansTitle })).toBeInTheDocument();
    expect(screen.getByText(texts.noPlans)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.noPlansCta })).toHaveAttribute('href', '/meal-plans');
    expect(screen.queryByRole('button', { name: texts.generateButton })).not.toBeInTheDocument();
  });

  it('offers the list of a plan that has none, and makes it with what the form names', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aList as never);
    renderWith({ plans: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }] });

    expect(await screen.findByRole('heading', { name: texts.noListsTitle })).toBeInTheDocument();
    expect(screen.getByText(texts.noLists)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.noListsCta }));

    await vi.waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/shopping-lists/generate', { planId: PLAN, fromDate: '2026-01-05', toDate: '2026-01-07' }));
  });
});
