// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { aPublicConfig } from '@/testing/public-config';
import { failReadsAgain } from '@/testing/read-again';
import messages from '../../../../messages/en.json';
import RecipesPage from './page';

const texts = messages.recipes;

// The address the page is opened at: `?tab=mine` opens on one's own recipes.
let address = '';
/** Where the page sends the person, as the router is asked. */
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address),
  useRouter: () => ({ push }),
}));
/** How the account asks a model: the button that drafts a recipe waits for one. */
let aiMode = 'none';
const PROFILE = '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f';
const TOFU = '7b0e6a52-0d0a-4d6f-9d3e-3f5f0a1b2c3d';

/** What the page asked the library for, last: the parts of the query by name. */
let asked: URLSearchParams = new URLSearchParams();

/** What the library answers: the recipes of the page asked for, and how many there are in all. */
interface Library {
  items: ({ title: string } & Record<string, unknown>)[];
  total: number;
  totalPages: number;
}

/**
 * The page of an account with `profiles` profiles, the first favouring `favoured` ingredients, and `mine` its own recipes;
 * the library answers with `library`, empty unless said.
 */
async function renderPage(
  profiles = 1,
  favoured: string[] = [TOFU],
  mine: unknown[] = [],
  library: Library = { items: [], total: 0, totalPages: 0 },
) {
  vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path.startsWith('/recipes?')) asked = new URLSearchParams(path.slice('/recipes?'.length));
    return Promise.resolve(
      (path === '/users/me'
        ? { aiMode }
        : path.startsWith('/recipes/mine?')
          ? {
              // A copy, so that a recipe changed in `mine` is a change of the answer.
              items: [...mine],
              page: 1,
              pageSize: 36,
              total: mine.length,
              totalPages: mine.length ? 1 : 0,
            }
          : path === '/profiles'
            ? Array.from({ length: profiles }, (_, i) => ({
                id: i === 0 ? PROFILE : `${PROFILE.slice(0, -1)}${i}`,
                name: i === 0 ? 'Me' : `Other ${i}`,
                preferences: { favoriteIngredientIds: i === 0 ? favoured : [] },
              }))
            : path.startsWith('/recipes?')
              ? { ...library, page: Number(asked.get('page')), pageSize: 36 }
              : path.startsWith('/ingredients?search=')
                ? [{ id: TOFU, name: 'Firm tofu' }]
                : path.startsWith('/ingredients?ids=')
                  ? [{ id: TOFU, name: 'Firm tofu' }]
                  : []) as never,
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <RecipesPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  // What the tab opened shows first: the library's first recipe or its word for none, or one's own first recipe.
  await screen.findByText(
    address === 'tab=mine'
      ? (mine[0] as { title: string }).title
      : (library.items[0]?.title ?? texts.noneAtAll),
  );
  return client;
}

/** Wait until the library was asked with `part` set to `value`, and say everything it was asked. */
async function askedWith(part: string, value: string): Promise<Record<string, string>> {
  await vi.waitFor(() => expect(asked.get(part)).toBe(value));
  return Object.fromEntries(asked);
}

describe('the recipe library, narrowed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = new URLSearchParams();
  });

  it('asks the API for a page of everything while nothing narrows it', async () => {
    await renderPage();

    expect(Object.fromEntries(asked)).toEqual({ page: '1', pageSize: '36' });
    // The narrower ways to look are folded away, and none of them is at work.
    expect(screen.getByText(texts.moreFilters)).toBeInTheDocument();
  });

  it('asks for a cuisine and for what a serving holds, and says how many of the folded filters are at work', async () => {
    await renderPage();

    await userEvent.selectOptions(screen.getByLabelText(texts.cuisine), 'asian');
    await userEvent.type(screen.getByLabelText(texts.minProtein), '30');
    await userEvent.type(screen.getByLabelText(texts.maxCarbs), '40');

    expect(await askedWith('maxCarbs', '40')).toMatchObject({
      cuisine: 'asian',
      minProtein: '30',
      maxCarbs: '40',
      page: '1',
    });
    expect(screen.getByText('More filters: 3 at work')).toBeInTheDocument();
  });

  it('asks for recipes with the ingredients picked and without the allergens ticked', async () => {
    await renderPage();
    const ingredients = within(screen.getByRole('group', { name: texts.withIngredients }));

    await userEvent.type(ingredients.getByRole('textbox'), 'tofu');
    await userEvent.click(await ingredients.findByRole('checkbox', { name: 'Firm tofu' }));
    await userEvent.click(ingredients.getByRole('button', { name: 'Add the ticked (1)' }));
    expect(await askedWith('ingredientIds', TOFU)).not.toHaveProperty('profileId');

    await userEvent.click(
      screen.getByRole('button', { name: messages.pickers.allergensPlaceholder }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: messages.enums.allergen.gluten }));
    await userEvent.click(screen.getByRole('checkbox', { name: messages.enums.allergen.dairy }));

    expect(await askedWith('withoutAllergens', 'gluten,dairy')).toMatchObject({
      ingredientIds: TOFU,
    });
  });

  it('asks the API, with the profile, for what the profile marked and for what holds an ingredient it favours', async () => {
    await renderPage();

    await userEvent.selectOptions(screen.getByLabelText(texts.marked), 'often');
    expect(await askedWith('marked', 'often')).toMatchObject({ profileId: PROFILE });

    await userEvent.click(screen.getByLabelText(texts.usesFavorites));
    expect(await askedWith('favoriteIngredients', 'true')).toMatchObject({
      profileId: PROFILE,
      marked: 'often',
    });
  });

  it('says so when the profile favours no ingredient, and asks whose marks are meant only on an account with several profiles', async () => {
    await renderPage(1, []);
    expect(screen.queryByLabelText(texts.favoritesProfile)).toBeNull();

    await userEvent.click(screen.getByLabelText(texts.usesFavorites));

    expect(
      await screen.findByText('Me has no favourites yet — set them on the profile page.'),
    ).toBeInTheDocument();
  });

  it('asks about the profile that was chosen, on an account with several', async () => {
    await renderPage(2);

    await userEvent.selectOptions(screen.getByLabelText(texts.marked), 'avoid');
    await userEvent.selectOptions(
      screen.getByLabelText(texts.favoritesProfile),
      `${PROFILE.slice(0, -1)}1`,
    );

    expect(await askedWith('profileId', `${PROFILE.slice(0, -1)}1`)).toMatchObject({
      marked: 'avoid',
    });
  });

  it('takes every filter away at once', async () => {
    await renderPage();
    await userEvent.selectOptions(screen.getByLabelText(texts.cuisine), 'asian');
    await userEvent.selectOptions(screen.getByLabelText(texts.marked), 'marked');
    await askedWith('marked', 'marked');

    await userEvent.click(screen.getByRole('button', { name: texts.clearFilters }));

    await vi.waitFor(() =>
      expect(Object.fromEntries(asked)).toEqual({ page: '1', pageSize: '36' }),
    );
    expect(screen.getByText(texts.moreFilters)).toBeInTheDocument();
  });
});

describe('the recipe library, a page at a time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = new URLSearchParams();
  });

  it('says which page of how many is shown, and asks for the next', async () => {
    await renderPage(1, [TOFU], [], {
      items: [
        {
          id: '3d8b2f1a-0c1d-4e2f-9a3b-4c5d6e7f8a01',
          title: 'A curated dinner',
          description: '',
          servings: 1,
          mealTypes: ['dinner'],
          dietTags: [],
          ingredients: [],
          steps: ['Cook.'],
          prepMinutes: 10,
          cookMinutes: 10,
          difficulty: 'easy',
          cuisine: null,
          allergens: [],
          nutritionPerServing: { calories: 500, protein: 30, fat: 20, carbs: 50 },
          origin: 'curated',
          byModel: null,
          source: null,
        },
      ],
      total: 183,
      totalPages: 6,
    });

    const pages = within(screen.getByRole('navigation', { name: texts.pagination.label }));
    expect(pages.getByText('Page 1 of 6')).toBeInTheDocument();
    expect(pages.getByText('Showing 1–36 of 183')).toBeInTheDocument();
    expect(pages.getByRole('button', { name: texts.pagination.prev })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const next = pages.getByRole('button', { name: texts.pagination.next });
    await userEvent.click(next);

    expect(await askedWith('page', '2')).toEqual({ page: '2', pageSize: '36' });
    expect(await screen.findByText('Page 2 of 6')).toBeInTheDocument();
    // The list stays while the next page comes, so the button pressed keeps the focus.
    expect(next).toBeInTheDocument();
    expect(next).toHaveFocus();
  });
});

describe("the recipes of one's own, while there are none", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = new URLSearchParams();
  });

  it('says what lands there and offers the way to the first, with why it waits where no model can be asked', async () => {
    await renderPage();

    await userEvent.click(screen.getByRole('button', { name: texts.tabs.mine }));

    expect(await screen.findByRole('heading', { name: texts.mineEmptyTitle })).toBeInTheDocument();
    expect(screen.getByText(texts.mineEmpty)).toBeInTheDocument();
    // The buttons of the page's head, a second time: here they are the way on. This account has AI off.
    const drafts = screen.getAllByRole('button', { name: texts.aiDraft });
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) expect(draft).toBeDisabled();
    // Writing one by hand waits for nothing.
    const writes = screen.getAllByRole('link', { name: texts.write });
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write).toHaveAttribute('href', '/recipes/new');
  });

  it("says the same whatever narrows the library: its filters are not asked of one's own recipes", async () => {
    await renderPage();
    await userEvent.type(screen.getByPlaceholderText(texts.searchPlaceholder), 'soup');
    expect(await screen.findByText(texts.noneFiltered)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: texts.tabs.mine }));

    expect(await screen.findByRole('heading', { name: texts.mineEmptyTitle })).toBeInTheDocument();
    expect(screen.queryByText(texts.noneFiltered)).not.toBeInTheDocument();
  });
});

describe("the recipes of one's own", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A recipe of the account's own, as the API lists it. */
  const own = (id: string, title: string, origin: 'ai' | 'swap' | 'manual', submitted = false) => ({
    id,
    title,
    description: '',
    servings: 1,
    mealTypes: ['dinner'],
    dietTags: [],
    ingredients: [],
    steps: ['Cook.'],
    prepMinutes: 10,
    cookMinutes: 10,
    difficulty: 'easy',
    cuisine: null,
    allergens: [],
    nutritionPerServing: { calories: 500, protein: 30, fat: 20, carbs: 50 },
    origin,
    byModel: origin === 'ai' ? 'written' : null,
    source: null,
    submitted,
  });

  it('show one a model just wrote among them, and open it', async () => {
    address = 'tab=mine';
    aiMode = 'byok';
    const mine = [own('a1a1a1a1-0000-4000-8000-000000000001', 'Soup of mine', 'manual')];
    await renderPage(1, [TOFU], mine);
    const written = own('b2b2b2b2-0000-4000-8000-000000000002', 'Pork with peppers', 'ai');
    vi.spyOn(api, 'post').mockImplementation(async () => {
      mine.unshift(written);
      return { recipe: { id: written.id } } as never;
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.aiDraft }));
    await user.click(await screen.findByRole('button', { name: messages.aiRecipeDraft.submit }));

    // The list on the page is read again, and the recipe opens, as on the phone.
    expect(await screen.findByText('Pork with peppers')).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith(`/recipes/${written.id}`);
    aiMode = 'none';
    address = '';
  });

  it('offer to submit one a model wrote, and neither one the curators have already nor one made by swapping an ingredient', async () => {
    await renderPage(
      1,
      [TOFU],
      [
        own('2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01', 'A dinner a model wrote', 'ai'),
        own('2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f02', 'My bowl with chicken for tofu', 'swap'),
        // As one the instance's model wrote is, the moment it is written.
        own('2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f03', 'A lunch the curators have', 'ai', true),
      ],
    );

    await userEvent.click(screen.getByRole('button', { name: texts.tabs.mine }));

    const card = async (title: string) =>
      (await screen.findByText(title)).closest('div.relative') as HTMLElement;
    expect(
      within(await card('A dinner a model wrote')).getByRole('button', { name: texts.submit }),
    ).toBeInTheDocument();
    for (const title of ['My bowl with chicken for tofu', 'A lunch the curators have']) {
      expect(within(await card(title)).queryByRole('button', { name: texts.submit })).toBeNull();
    }
  });

  it('are the first thing shown where the address asks for them', async () => {
    address = 'tab=mine';
    try {
      await renderPage(
        1,
        [TOFU],
        [own('2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01', 'A dinner a model wrote', 'ai')],
      );

      expect(await screen.findByText('A dinner a model wrote')).toBeInTheDocument();
    } finally {
      address = '';
    }
  });

  it('offer it no more once it is sent', async () => {
    const id = '2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01';
    const mine = [own(id, 'A dinner a model wrote', 'ai')];
    await renderPage(1, [TOFU], mine);
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: texts.tabs.mine }));
    const card = (await screen.findByText('A dinner a model wrote')).closest(
      'div.relative',
    ) as HTMLElement;
    // What the list says of it from now on.
    mine[0] = own(id, 'A dinner a model wrote', 'ai', true);

    await userEvent.click(within(card).getByRole('button', { name: texts.submit }));

    expect(post).toHaveBeenCalledExactlyOnceWith(`/recipes/${id}/submit`);
    expect(await screen.findByText(texts.submitDone)).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(within(card).queryByRole('button', { name: texts.submit })).toBeNull(),
    );
  });

  it('offer to edit each of them, whoever wrote it', async () => {
    const ids = [
      '2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01',
      '2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f02',
      '2c9a1f0e-1b2c-4d3e-8f4a-5b6c7d8e9f03',
    ];
    await renderPage(
      1,
      [TOFU],
      [
        own(ids[0]!, 'A dinner a model wrote', 'ai'),
        own(ids[1]!, 'My bowl with chicken for tofu', 'swap'),
        own(ids[2]!, 'My own soup', 'manual'),
      ],
    );

    await userEvent.click(screen.getByRole('button', { name: texts.tabs.mine }));
    await screen.findByText('My own soup');

    expect(
      screen.getAllByRole('link', { name: texts.edit }).map((link) => link.getAttribute('href')),
    ).toEqual(ids.map((id) => `/recipes/${id}/edit`));
  });
});

describe('the recipe library read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = new URLSearchParams();
  });

  it('keeps the recipes it showed when a read fails again, says why above them, and reads again when asked', async () => {
    const dinner = {
      id: '3d8b2f1a-0c1d-4e2f-9a3b-4c5d6e7f8a01',
      title: 'A curated dinner',
      description: '',
      servings: 1,
      mealTypes: ['dinner'],
      dietTags: [],
      ingredients: [],
      steps: ['Cook.'],
      prepMinutes: 10,
      cookMinutes: 10,
      difficulty: 'easy',
      cuisine: null,
      allergens: [],
      nutritionPerServing: { calories: 500, protein: 30, fat: 20, carbs: 50 },
      origin: 'curated',
      byModel: null,
      source: null,
    };
    const client = await renderPage(1, [TOFU], [], { items: [dinner], total: 1, totalPages: 1 });

    const answerAgain = await failReadsAgain(client);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByText('A curated dinner')).toBeInTheDocument();
    answerAgain();
    await userEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: messages.common.retry,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
    expect(screen.getByText('A curated dinner')).toBeInTheDocument();
  });
});
