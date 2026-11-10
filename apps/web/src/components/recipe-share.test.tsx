// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedIngredient, Recipe } from '@diet-app/shared';
import messages from '../../messages/en.json';
import { RecipeShare } from './recipe-share';

const { recipePdf, saveFile } = vi.hoisted(() => ({
  recipePdf: vi.fn(),
  saveFile: vi.fn(),
}));
vi.mock('./recipe-pdf', () => ({ recipePdf }));
vi.mock('@/lib/save-file', () => ({ saveFile }));

const texts = messages.recipeShare;

const oats = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Oat bowl',
  description: 'Oats with a banana.',
  servings: 1,
  mealTypes: ['breakfast'],
  dietTags: ['vegan'],
  prepMinutes: 5,
  cookMinutes: 5,
  difficulty: 'easy',
  cuisine: null,
  allergens: [],
  origin: 'curated',
  steps: ['Warm the drink.', 'Stir in the oats.'],
  ingredients: [
    {
      ingredientId: '22222222-2222-4222-8222-222222222222',
      name: 'Oats',
      quantity: 60,
      unit: 'g',
      display: { quantity: 60, unit: 'g' },
      note: null,
    },
    {
      ingredientId: '33333333-3333-4333-8333-333333333333',
      name: 'Banana',
      quantity: 120,
      unit: 'g',
      display: { quantity: 1, unit: 'piece', grams: 120 },
      note: 'sliced',
    },
  ],
  nutritionPerServing: { calories: 421, protein: 14, fat: 9, carbs: 68 },
  labelPerServing: { fiber: 7, sugars: 15, salt: 0.1, saturatedFat: 1.5 },
  byModel: null,
  source: null,
} as unknown as Recipe;

/** The lines of a meal of a plan: twice the oats, for two servings. */
const planned: PlannedIngredient[] = [
  {
    ingredientId: '22222222-2222-4222-8222-222222222222',
    name: 'Oats',
    quantity: 120,
    unit: 'g',
    display: { quantity: 120, unit: 'g' },
    note: null,
  },
];

function renderShare(props: Partial<Parameters<typeof RecipeShare>[0]> = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecipeShare recipe={oats} {...props} />
    </NextIntlClientProvider>,
  );
}

/** A computer: a clipboard and no sheet of apps. */
function onAComputer() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  return writeText;
}

/** A phone whose browser has the system's sheet: `share` answers as it is told. */
function onAPhone(share = vi.fn().mockResolvedValue(undefined), canShare = vi.fn(() => true)) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, share, canShare });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' })),
  );
  return { share, canShare, writeText };
}

const lines = (text: string) => text.split('\n');

describe('a recipe sent to somebody', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is copied on a computer as the recipe gives it, and the page says so', async () => {
    const writeText = onAComputer();
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(lines(writeText.mock.calls[0]![0] as string)).toEqual([
      'Oat bowl',
      '',
      'Ingredients for 1 serving:',
      '- Oats: 60 g',
      '- Banana: 1 piece (120 g) — sliced',
      '',
      'Method:',
      '1. Warm the drink.',
      '2. Stir in the oats.',
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(texts.copied);
  });

  it('holds the amounts and servings of the meal of a plan it was opened from', async () => {
    const writeText = onAComputer();
    renderShare({ amounts: planned, servings: 2 });

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    const text = writeText.mock.calls[0]![0] as string;
    expect(lines(text).slice(2, 4)).toEqual(['Ingredients for 2 servings:', '- Oats: 120 g']);
    expect(text).not.toContain('Banana');
  });

  it('gives no figures of the recipe', async () => {
    const writeText = onAComputer();
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    const text = writeText.mock.calls[0]![0] as string;
    expect(text).not.toMatch(/kcal|421|protein|fat|carb/i);
  });

  it('says where a recipe that was taken in is from and its licence, and that a model had a part in it', async () => {
    const writeText = onAComputer();
    renderShare({
      recipe: {
        ...oats,
        byModel: 'changed',
        source: { url: 'https://recipes.example/oats', license: 'CC BY-SA 4.0' },
      },
    });

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(lines(writeText.mock.calls[0]![0] as string).slice(-3)).toEqual([
      '',
      'From https://recipes.example/oats · Licence: CC BY-SA 4.0',
      texts.byModel,
    ]);
  });

  it('says only the licence of a recipe that was taken in without an address', async () => {
    const writeText = onAComputer();
    renderShare({ recipe: { ...oats, source: { url: null, license: 'Public domain' } } });

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(lines(writeText.mock.calls[0]![0] as string).at(-1)).toBe('Licence: Public domain');
  });

  it('is shown to be copied by hand where the browser gives the page no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    const byHand = within(await screen.findByRole('dialog', { name: texts.copyByHand }));
    expect(byHand.getByText(messages.common.copyByHandHint)).toBeInTheDocument();
    expect(
      (byHand.getByRole('textbox', { name: texts.copyByHand }) as HTMLTextAreaElement).value,
    ).toMatch(/^Oat bowl\n\nIngredients for 1 serving:/);
  });

  it("goes to the system's sheet on a phone, with its title, and is not copied", async () => {
    const { share, writeText } = onAPhone();
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(share).toHaveBeenCalledWith({
      title: 'Oat bowl',
      text: expect.stringMatching(/^Oat bowl\n\nIngredients for 1 serving:\n- Oats: 60 g/),
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('leaves nothing said when the sheet is closed without sending', async () => {
    const { writeText } = onAPhone(
      vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError')),
    );
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('is copied where the sheet will not open', async () => {
    const { writeText } = onAPhone(
      vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')),
    );
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.text }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent(texts.copied);
  });

  it('is saved as a PDF named by its title on a computer, made of what the text holds', async () => {
    onAComputer();
    const made = new Blob(['%PDF-'], { type: 'application/pdf' });
    recipePdf.mockResolvedValue(made);
    renderShare({ amounts: planned, servings: 2 });

    await userEvent.click(screen.getByRole('button', { name: texts.pdf }));

    expect(recipePdf).toHaveBeenCalledWith(
      {
        title: 'Oat bowl',
        ingredientsHeading: 'Ingredients for 2\u00a0servings',
        ingredients: [{ name: 'Oats', amount: '120\u00a0g', note: null }],
        stepsHeading: 'Method',
        steps: ['Warm the drink.', 'Stir in the oats.'],
        notes: [],
      },
      messages.common.appName,
    );
    expect(saveFile).toHaveBeenCalledWith(made, 'oat-bowl.pdf');
  });

  it("goes as a file to the system's sheet on a phone that takes files", async () => {
    const { share } = onAPhone();
    recipePdf.mockResolvedValue(new Blob(['%PDF-'], { type: 'application/pdf' }));
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.pdf }));

    const sent = share.mock.calls[0]![0] as { title: string; files: File[] };
    expect(sent.title).toBe('Oat bowl');
    expect(sent.files.map((file) => [file.name, file.type])).toEqual([
      ['oat-bowl.pdf', 'application/pdf'],
    ]);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('is saved on a phone whose sheet takes no files', async () => {
    const { share } = onAPhone(
      vi.fn().mockResolvedValue(undefined),
      vi.fn(() => false),
    );
    recipePdf.mockResolvedValue(new Blob(['%PDF-'], { type: 'application/pdf' }));
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.pdf }));

    expect(share).not.toHaveBeenCalled();
    expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), 'oat-bowl.pdf');
  });

  it('says so when the PDF could not be made', async () => {
    onAComputer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recipePdf.mockRejectedValue(new Error('no typeface'));
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: texts.pdf }));

    expect(await screen.findByRole('status')).toHaveTextContent(texts.pdfFailed);
    expect(saveFile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: texts.pdf })).toBeEnabled();
  });
});
