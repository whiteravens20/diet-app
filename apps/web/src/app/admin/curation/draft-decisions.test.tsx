// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocaleReview } from '@diet-app/shared';
import { adminApi, type IngredientNameDraft, type RecipeDraft } from '@/lib/admin-api';
import messages from '../../../../messages/en.json';
import { IngredientPanel } from './ingredient-panel';
import { RecipeDraftRow } from './recipe-draft-row';
import { ReviewSignature, SignatureField } from './review-signature';

const texts = messages.admin.curation;

/** English approved and Polish rejected: the decisions each language has now. */
const DECIDED: LocaleReview[] = [
  {
    locale: 'en',
    action: 'APPROVE',
    byRole: 'ADMIN',
    reviewedByLabel: 'Admin',
    reason: null,
    reviewedAt: '2026-10-26T10:00:00.000Z',
  },
  {
    locale: 'pl',
    action: 'REJECT',
    byRole: 'REVIEWER',
    reviewedByLabel: 'Ola',
    reason: 'Literówka',
    reviewedAt: '2026-10-26T10:05:00.000Z',
  },
];

const aRecipeDraft = (): RecipeDraft =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'greek-yogurt-with-almonds-honey',
    titles: { en: 'Greek yogurt with almonds & honey', pl: 'Jogurt grecki z migdałami i miodem' },
    descriptions: { en: 'A quick snack.', pl: 'Szybka przekąska.' },
    steps: { en: ['Mix.'], pl: ['Wymieszaj.'] },
    locales: ['en', 'pl'],
    servings: 1,
    mealTypes: ['snack'],
    dietTags: [],
    prepMinutes: 5,
    cookMinutes: 0,
    difficulty: 'easy',
    cuisine: null,
    complexity: 'simple',
    caloriesPerServing: 320,
    proteinPerServing: 18,
    fatPerServing: 16,
    carbsPerServing: 24,
    allergens: [],
    ingredients: [{ slug: 'greek-yogurt', quantity: 170, unit: 'g' }],
    status: 'PENDING',
    source: 'AI',
    batchId: 'batch',
    modelUsed: null,
    generatorPrompt: null,
    generationSpec: null,
    provenanceUrl: null,
    provenanceLicense: null,
    shippedAt: null,
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T10:05:00.000Z',
    localeReviews: DECIDED,
    pastReviews: [],
  }) as RecipeDraft;

const anIngredientNameDraft = (): IngredientNameDraft => ({
  id: '22222222-2222-4222-8222-222222222222',
  ingredientId: '33333333-3333-4333-8333-333333333333',
  ingredientSlug: 'nuts-almonds-whole-raw',
  rawDescription: 'Nuts, almonds, whole, raw',
  suggestions: { name: { en: 'Almonds', pl: 'Migdały' } },
  locales: ['en', 'pl'],
  status: 'PENDING',
  source: 'AI',
  batchId: 'batch',
  modelUsed: null,
  generatorPrompt: null,
  shippedAt: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  updatedAt: '2026-10-26T10:05:00.000Z',
  edited: false,
  replaced: false,
  localeReviews: DECIDED,
  pastReviews: [],
});

const shown = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReviewSignature>
        <SignatureField />
        {node}
      </ReviewSignature>
    </NextIntlClientProvider>,
  );

/** How many names each way of writing them takes on, for the panel's buttons. */
const QUEUE = { missing: 12, rejected: 5, pending: 231, unapproved: 230, approved: 2 };

const idleRunner = {
  status: 'idle',
  configured: true,
  processed: 0,
  total: 0,
  failed: 0,
  written: 0,
  skipped: 0,
  note: null,
} as never;

/** The panel of names over these drafts, with no run going. */
const panelOver = (drafts: IngredientNameDraft[], queue = QUEUE) => {
  vi.spyOn(adminApi, 'ingredientNamerStatus').mockResolvedValue(idleRunner);
  vi.spyOn(adminApi, 'shipConfig').mockRejectedValue(new Error('not asked about here'));
  const list = vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
    items: drafts,
    page: 1,
    pageSize: 20,
    total: drafts.length,
    totalPages: 1,
  } as never);
  shown(<IngredientPanel queue={queue} />);
  return list;
};

const signed = async (name = 'Admin') =>
  userEvent.type(screen.getByRole('textbox', { name: texts.signatureLabel }), name);

/** The approve and reject buttons of a language, as the row names them. */
const decision = (action: string, locale: string) =>
  screen.getByRole('button', { name: `${action} · ${locale}` });

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the decisions of a draft in the administrator’s panel', () => {
  it('cannot be taken again for a recipe in a language that has it, and can be changed', async () => {
    shown(<RecipeDraftRow draft={aRecipeDraft()} onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Greek yogurt with almonds/ }));

    expect(decision(texts.approve, 'en')).toBeDisabled();
    expect(decision(texts.reject, 'en')).toBeEnabled();
    expect(decision(texts.approve, 'pl')).toBeEnabled();
    expect(decision(texts.reject, 'pl')).toBeDisabled();
  });

  it('cannot be taken again for the name of an ingredient either', async () => {
    vi.spyOn(adminApi, 'ingredientNamerStatus').mockResolvedValue(null as never);
    vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
      items: [anIngredientNameDraft()],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    } as never);

    shown(<IngredientPanel queue={QUEUE} />);

    expect(await screen.findByRole('button', { name: `${texts.approve} · en` })).toBeDisabled();
    expect(decision(texts.reject, 'en')).toBeEnabled();
    expect(decision(texts.approve, 'pl')).toBeEnabled();
    expect(decision(texts.reject, 'pl')).toBeDisabled();
  });
});

describe('the drafts of names in the administrator’s panel', () => {
  it('are rejected all at once, with one name and one reason, so that the next run writes them again', async () => {
    const shownDrafts = [
      { ...anIngredientNameDraft(), localeReviews: [] },
      {
        ...anIngredientNameDraft(),
        id: '44444444-4444-4444-8444-444444444444',
        ingredientSlug: 'fish-salmon-atlantic-farm-raised-raw',
        localeReviews: [],
      },
    ];
    vi.spyOn(adminApi, 'ingredientNamerStatus').mockResolvedValue(null as never);
    vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
      items: shownDrafts,
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    } as never);
    const reject = vi
      .spyOn(adminApi, 'rejectIngredientNameDrafts')
      .mockResolvedValue({ rejected: shownDrafts.map((draft) => draft.id), skipped: [] });

    shown(<IngredientPanel queue={QUEUE} />);
    const press = await screen.findByRole('button', { name: 'Reject the 2 shown' });
    await signed();
    await userEvent.type(
      screen.getByRole('textbox', { name: texts.bulkReason }),
      'Write them again.',
    );
    await userEvent.click(press);

    expect(reject).toHaveBeenCalledExactlyOnceWith(
      shownDrafts.map((draft) => draft.id),
      'Admin',
      'Write them again.',
    );
    expect(await screen.findByText('2 rejected.')).toBeInTheDocument();
  });
});

describe('a decision in the administrator’s panel', () => {
  const waiting = (): IngredientNameDraft => ({ ...anIngredientNameDraft(), localeReviews: [] });

  it('is not taken without a signature: the field says so and takes the focus', async () => {
    panelOver([waiting()]);
    const approve = vi.spyOn(adminApi, 'approveIngredientNameDraft');

    await userEvent.click(await screen.findByRole('button', { name: `${texts.approve} · pl` }));

    expect(approve).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(texts.signatureNeeded);
    expect(screen.getByRole('textbox', { name: texts.signatureLabel })).toHaveFocus();
  });

  it('goes under the signature, which this browser remembers', async () => {
    panelOver([waiting()]);
    const approve = vi.spyOn(adminApi, 'approveIngredientNameDraft').mockResolvedValue(waiting());

    const press = await screen.findByRole('button', { name: `${texts.approve} · pl` });
    await signed('Pavlo');
    await userEvent.click(press);

    expect(approve).toHaveBeenCalledExactlyOnceWith(waiting().id, 'pl', 'Pavlo');
    expect(window.localStorage.getItem('admin.reviewSignature')).toBe('Pavlo');
  });

  it('finds the signature kept from before, and works when the browser keeps nothing', async () => {
    window.localStorage.setItem('admin.reviewSignature', 'Ola');
    panelOver([waiting()]);
    expect(await screen.findByRole('textbox', { name: texts.signatureLabel })).toHaveValue('Ola');
    cleanup();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    panelOver([waiting()]);
    await signed('Ania');

    expect(screen.getByRole('textbox', { name: texts.signatureLabel })).toHaveValue('Ania');
    expect(write).toHaveBeenCalled();
  });

  it('rejects with the reason written in the row, and asks for it in no window', async () => {
    panelOver([waiting()]);
    const prompt = vi.spyOn(window, 'prompt');
    const reject = vi.spyOn(adminApi, 'rejectIngredientNameDraft').mockResolvedValue(waiting());

    const press = await screen.findByRole('button', { name: `${texts.reject} · pl` });
    await signed();
    await userEvent.type(
      screen.getByRole('textbox', { name: texts.decisionReason }),
      'Too general',
    );
    await userEvent.click(press);

    expect(reject).toHaveBeenCalledExactlyOnceWith(waiting().id, 'pl', 'Admin', 'Too general');
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('writing names again in the administrator’s panel', () => {
  const waiting = (over: Partial<IngredientNameDraft> = {}): IngredientNameDraft => ({
    ...anIngredientNameDraft(),
    localeReviews: [],
    ...over,
  });
  const running = { ...(idleRunner as object), status: 'running', total: 1 } as never;

  it('offers three runs with how many each takes on, and asks with the number first', async () => {
    panelOver([]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const start = vi.spyOn(adminApi, 'startIngredientNamer').mockResolvedValue(running);
    const again = vi.spyOn(adminApi, 'regenerateIngredientNames').mockResolvedValue(running);
    await signed();

    await userEvent.click(await screen.findByRole('button', { name: 'Generate the missing · 12' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Generate the rejected again · 5' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Generate the unapproved again · 230' }),
    );

    expect(confirm.mock.calls.map(([question]) => question)).toEqual([
      expect.stringContaining('names for 12 ingredients'),
      expect.stringContaining('in place of 5 rejected ones'),
      expect.stringContaining('in place of 230 that wait'),
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(again).not.toHaveBeenCalled();
  });

  it('starts each run for what it says', async () => {
    panelOver([]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const start = vi.spyOn(adminApi, 'startIngredientNamer').mockResolvedValue(idleRunner);
    const again = vi.spyOn(adminApi, 'regenerateIngredientNames').mockResolvedValue(idleRunner);
    await signed();
    await userEvent.type(screen.getByRole('textbox', { name: texts.bulkReason }), 'Too literal');

    await userEvent.click(await screen.findByRole('button', { name: /^Generate the missing/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^Generate the rejected/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^Generate the unapproved/ }));

    expect(start.mock.calls.map(([spec]) => spec)).toEqual([
      { scope: 'all-usda-missing' },
      { scope: 'rejected' },
    ]);
    expect(again).toHaveBeenCalledExactlyOnceWith({
      scope: 'unapproved',
      reviewedByLabel: 'Admin',
      reason: 'Too literal',
    });
  });

  it('wants a signature for the unapproved: they are rejected under it', async () => {
    panelOver([]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const again = vi.spyOn(adminApi, 'regenerateIngredientNames');

    await userEvent.click(await screen.findByRole('button', { name: /^Generate the unapproved/ }));

    expect(confirm).not.toHaveBeenCalled();
    expect(again).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(texts.signatureNeeded);
  });

  it('has nothing to press where there is nothing to write', async () => {
    panelOver([], { missing: 0, rejected: 0, pending: 0, unapproved: 0, approved: 0 });

    expect(await screen.findByRole('button', { name: /^Generate the missing/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Generate the rejected/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Generate the unapproved/ })).toBeDisabled();
  });

  it('writes a row that waits anew with its reason, asking nothing when no person touched it', async () => {
    panelOver([waiting()]);
    const confirm = vi.spyOn(window, 'confirm');
    const again = vi.spyOn(adminApi, 'regenerateIngredientNames').mockResolvedValue(idleRunner);
    const press = await screen.findByRole('button', { name: texts.regenerate });
    await signed();
    await userEvent.type(
      screen.getByRole('textbox', { name: texts.decisionReason }),
      'Too general',
    );

    await userEvent.click(press);

    expect(confirm).not.toHaveBeenCalled();
    expect(again).toHaveBeenCalledExactlyOnceWith({
      scope: 'named',
      ids: [waiting().id],
      reviewedByLabel: 'Admin',
      reason: 'Too general',
    });
  });

  it.each([
    ['changed by hand', { edited: true }],
    [
      'approved in a language',
      {
        localeReviews: [
          {
            locale: 'en',
            action: 'APPROVE',
            byRole: 'ADMIN',
            reviewedByLabel: 'Admin',
            reason: null,
            reviewedAt: '2026-10-26T10:00:00.000Z',
          },
        ],
      },
    ],
  ] as [string, Partial<IngredientNameDraft>][])(
    'asks before writing anew a row %s, and leaves it when told no',
    async (_what, over) => {
      panelOver([waiting(over)]);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const again = vi.spyOn(adminApi, 'regenerateIngredientNames');
      const press = await screen.findByRole('button', { name: texts.regenerate });
      await signed();

      await userEvent.click(press);

      expect(confirm).toHaveBeenCalledExactlyOnceWith(texts.regenerateTouchedConfirm);
      expect(again).not.toHaveBeenCalled();
    },
  );

  it('says of a row that a person changed it', async () => {
    panelOver([waiting({ edited: true })]);

    expect(await screen.findByText(texts.editedMark)).toBeInTheDocument();
  });

  it('writes a rejected row anew by its ingredient, with no signature: nothing is rejected', async () => {
    panelOver([waiting({ status: 'REJECTED' })]);
    const start = vi.spyOn(adminApi, 'startIngredientNamer').mockResolvedValue(idleRunner);

    await userEvent.click(await screen.findByRole('button', { name: texts.regenerate }));

    expect(start).toHaveBeenCalledExactlyOnceWith({
      scope: 'specific-slugs',
      slugs: ['nuts-almonds-whole-raw'],
    });
    expect(screen.queryByRole('textbox', { name: texts.decisionReason })).toBeNull();
  });

  it.each(['APPROVED', 'SHIPPED'] as const)(
    'offers nothing of the kind for a row %s',
    async (status) => {
      panelOver([waiting({ status })]);

      await screen.findByText('Migdały');
      expect(screen.queryByRole('button', { name: texts.regenerate })).toBeNull();
    },
  );

  it('shows a replaced row as history, with nothing to press in it', async () => {
    panelOver([waiting({ status: 'REJECTED', replaced: true })]);

    expect(await screen.findByText(texts.replacedMark)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.regenerate })).toBeNull();
    expect(screen.queryByRole('button', { name: `${texts.approve} · pl` })).toBeNull();
    expect(screen.queryByRole('button', { name: texts.deleteAction })).toBeNull();
  });

  it('offers no new run while one is going, and follows one that was going when it opened', async () => {
    const status = vi
      .spyOn(adminApi, 'ingredientNamerStatus')
      .mockResolvedValueOnce(running)
      .mockResolvedValue(idleRunner);
    vi.spyOn(adminApi, 'shipConfig').mockRejectedValue(new Error('not asked about here'));
    vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
      items: [waiting()],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    } as never);

    shown(<IngredientPanel queue={QUEUE} />);

    expect(await screen.findByRole('button', { name: texts.regenerate })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Generate the missing/ })).toBeDisabled();
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: texts.regenerate })).toBeEnabled(),
    );
  });
});

describe('a recipe a user made, approved, in the administrator’s panel', () => {
  it('says before the press why it cannot go into the library, and offers no press', async () => {
    const draft = {
      ...aRecipeDraft(),
      source: 'AI_USER',
      status: 'APPROVED',
      localeReviews: [],
      libraryBlock: 'unknown-slug-at-ship: nuts-almonds-whole-raw',
    } as RecipeDraft;

    shown(<RecipeDraftRow draft={draft} onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Greek yogurt with almonds/ }));

    expect(screen.getByRole('button', { name: texts.promoteButton })).toBeDisabled();
    expect(
      screen.getByText(
        `${messages.errors.DRAFT_NOT_SHIPPABLE} uses an ingredient the catalogue no longer has: nuts-almonds-whole-raw`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(texts.promoteBlockedHint)).toBeInTheDocument();
  });

  it('goes into the library at a press when nothing stands in the way', async () => {
    const draft = {
      ...aRecipeDraft(),
      source: 'AI_USER',
      status: 'APPROVED',
      localeReviews: [],
      libraryBlock: null,
    } as RecipeDraft;

    shown(<RecipeDraftRow draft={draft} onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Greek yogurt with almonds/ }));

    expect(screen.getByRole('button', { name: texts.promoteButton })).toBeEnabled();
    expect(screen.queryByText(texts.promoteBlockedHint)).toBeNull();
  });
});
