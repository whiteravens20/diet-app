// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeImportResult, StoredImportRejection } from '@diet-app/shared';
import { adminApi } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../messages/en.json';
import polish from '../../../messages/pl.json';
import { RecipeImport } from './recipe-import';

const text = messages.admin.curation.import;
const recipe = JSON.stringify({
  '@type': 'Recipe',
  name: 'Salmon rice bowl',
  recipeIngredient: ['150 g salmon'],
});
const taken: RecipeImportResult = {
  batchId: 'imp-1',
  found: 2,
  drafted: [{ slug: 'salmon-rice-bowl', title: 'Salmon rice bowl' }],
  rejected: [
    {
      title: 'Garlic rice',
      sourceUrl: null,
      reasons: ['no-licence', 'unknown-ingredient: dragon fruit', 'a-rule-of-tomorrow: x'],
    },
  ],
  dryRun: false,
};
const kept = (title: string): StoredImportRejection => ({
  id: '11111111-1111-4111-8111-111111111111',
  batchId: 'imp-0',
  title,
  sourceUrl: null,
  reasons: ['line-without-amount: salt to taste'],
  createdAt: '2026-10-12T08:00:00.000Z',
});

/** The section as the panel shows it, with these refusals kept from earlier imports. */
async function renderImport(earlier: StoredImportRejection[] = [], locale: 'en' | 'pl' = 'en') {
  const rejections = vi.spyOn(adminApi, 'importRejections').mockResolvedValue(earlier);
  const onImported = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : polish}>
      <RecipeImport onImported={onImported} />
    </NextIntlClientProvider>,
  );
  await vi.waitFor(() => expect(rejections).toHaveBeenCalled());
  return { onImported, rejections };
}
const paste = async (document: string) => {
  const field = screen.getByRole('textbox', { name: text.document });
  await userEvent.click(field);
  await userEvent.paste(document);
};

describe('taking recipes in from elsewhere, in the panel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what it takes, that nothing is fetched and no model is asked, and can do nothing until there is a document', async () => {
    await renderImport();

    expect(screen.getByRole('region', { name: text.title })).toHaveTextContent(
      'One import takes up to 100 recipes. Nothing is fetched and no model is asked.',
    );
    expect(screen.getByRole('button', { name: text.look })).toBeDisabled();
    expect(screen.getByRole('button', { name: text.import })).toBeDisabled();
  });

  it('looks first: says what would come of the document, and has nothing read again', async () => {
    const send = vi
      .spyOn(adminApi, 'importRecipes')
      .mockResolvedValue({ ...taken, batchId: null, dryRun: true });
    const { onImported } = await renderImport();
    await paste(recipe);

    await userEvent.click(screen.getByRole('button', { name: text.look }));

    expect(send).toHaveBeenCalledExactlyOnceWith({ document: recipe, dryRun: true });
    expect(
      await screen.findByText('Recipes found: 2. Would become drafts: 1. Would be refused: 1.'),
    ).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('imports with what was said of the document, names what became a draft, and words why the rest was refused', async () => {
    const send = vi.spyOn(adminApi, 'importRecipes').mockResolvedValue(taken);
    const { onImported, rejections } = await renderImport();
    await paste(recipe);
    await userEvent.type(
      screen.getByRole('textbox', { name: text.sourceUrl }),
      'https://recipes.example/',
    );
    await userEvent.type(screen.getByRole('textbox', { name: text.licence }), ' CC BY 4.0 ');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Dinner' }));

    await userEvent.click(screen.getByRole('button', { name: text.import }));

    expect(send).toHaveBeenCalledExactlyOnceWith({
      document: recipe,
      sourceUrl: 'https://recipes.example/',
      license: 'CC BY 4.0',
      mealTypes: ['dinner'],
      dryRun: false,
    });
    const said = within(await screen.findByRole('status'));
    expect(said.getByText('Recipes found: 2. Drafts made: 1. Refused: 1.')).toBeInTheDocument();
    expect(said.getByText('Salmon rice bowl')).toBeInTheDocument();
    expect(said.getByText('Garlic rice')).toBeInTheDocument();
    expect(said.getByText('names no licence, and the import named none')).toBeInTheDocument();
    expect(
      said.getByText('the catalogue has no ingredient called “dragon fruit”'),
    ).toBeInTheDocument();
    // A reason this version has no words for is shown as the API wrote it.
    expect(said.getByText('a-rule-of-tomorrow: x')).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledOnce();
    expect(rejections).toHaveBeenCalledTimes(2);
  });

  it('says a reason as often as the recipe earned it', async () => {
    const twice = {
      title: 'Garlic rice',
      sourceUrl: null,
      reasons: ['line-without-amount: salt to taste', 'line-without-amount: salt to taste'],
    };
    vi.spyOn(adminApi, 'importRecipes').mockResolvedValue({
      batchId: null,
      found: 1,
      drafted: [],
      rejected: [twice],
      dryRun: true,
    });
    const complaints = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderImport();
    await paste(recipe);

    await userEvent.click(screen.getByRole('button', { name: text.look }));

    expect(await screen.findAllByText('a line has no amount: “salt to taste”')).toHaveLength(2);
    // Rows that share a key are what the library complains of, and may drop.
    expect(complaints.mock.calls.filter(([said]) => /same key/.test(String(said)))).toEqual([]);
  });

  it('says how many recipes of a document were beyond what one import looks at', async () => {
    vi.spyOn(adminApi, 'importRecipes').mockResolvedValue({
      batchId: null,
      found: 103,
      drafted: [],
      rejected: [],
      dryRun: true,
    });
    await renderImport();
    await paste(recipe);

    await userEvent.click(screen.getByRole('button', { name: text.look }));

    expect(
      await screen.findByText(
        'One import looks at the first 100 recipes of a document. The last 3 recipes of this document were left out: send them in another document.',
      ),
    ).toBeInTheDocument();
  });

  it('sends the text as it stands, and says so when the instance finds it is no JSON document', async () => {
    const send = vi
      .spyOn(adminApi, 'importRecipes')
      .mockRejectedValue(
        new ApiClientError(
          400,
          'IMPORT_NOT_JSON',
          'The document is not JSON that can hold recipes.',
        ),
      );
    await renderImport();

    await paste('{ name: Salmon }');
    await userEvent.click(screen.getByRole('button', { name: text.look }));

    expect(await screen.findByText(messages.errors.IMPORT_NOT_JSON)).toBeInTheDocument();
    expect(send).toHaveBeenCalledExactlyOnceWith({ document: '{ name: Salmon }', dryRun: true });
  });

  it('sends no document larger than one import takes, and says how large that is', async () => {
    const send = vi.spyOn(adminApi, 'importRecipes');
    await renderImport();

    await paste(JSON.stringify({ '@type': 'Recipe', name: 'x'.repeat(90_001) }));
    await userEvent.click(screen.getByRole('button', { name: text.import }));

    expect(
      await screen.findByText('The document is larger than one import takes (90 kB). Split it.'),
    ).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('measures the request and not the document: quotes and line ends take two bytes each on the way', async () => {
    const send = vi
      .spyOn(adminApi, 'importRecipes')
      .mockResolvedValue({ ...taken, batchId: null, dryRun: true });
    await renderImport();

    // 60 kB as a document, 120 kB once every quote of it is written with a stroke before it.
    await paste('"'.repeat(60_000));
    await userEvent.click(screen.getByRole('button', { name: text.look }));
    expect(
      await screen.findByText('The document is larger than one import takes (90 kB). Split it.'),
    ).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByRole('textbox', { name: text.document }));
    await paste('x'.repeat(60_000));
    await userEvent.click(screen.getByRole('button', { name: text.look }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  });

  it('reads the document from a file', async () => {
    await renderImport();

    await userEvent.upload(
      screen.getByLabelText(text.fromFile),
      new File([recipe], 'recipes.json', { type: 'application/json' }),
    );

    await vi.waitFor(() =>
      expect(screen.getByRole('textbox', { name: text.document })).toHaveValue(recipe),
    );
    expect(screen.getByRole('button', { name: text.import })).toBeEnabled();
  });

  it('says what the API refused the request for', async () => {
    vi.spyOn(adminApi, 'importRecipes').mockRejectedValue(
      new ApiClientError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.'),
    );
    await renderImport();
    await paste(recipe);

    await userEvent.click(screen.getByRole('button', { name: text.import }));

    expect(await screen.findByText(messages.errors.PAYLOAD_TOO_LARGE)).toBeInTheDocument();
  });

  it("shows what earlier imports refused, in the reader's language, and forgets it when told to", async () => {
    const clear = vi.spyOn(adminApi, 'clearImportRejections').mockResolvedValue(undefined);
    await renderImport(
      [kept('Garlic rice'), { ...kept('Fried rice'), id: '22222222-2222-4222-8222-222222222222' }],
      'pl',
    );

    const earlier = await screen.findByText('Odrzucone przez wcześniejsze importy: 2 przepisy');
    await userEvent.click(earlier);
    expect(screen.getByText('Garlic rice')).toBeInTheDocument();
    expect(screen.getAllByText('linia nie ma ilości: „salt to taste”')).toHaveLength(2);

    await userEvent.click(
      screen.getByRole('button', { name: polish.admin.curation.import.clearKept }),
    );

    expect(clear).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(screen.queryByText('Garlic rice')).not.toBeInTheDocument());
  });
});
