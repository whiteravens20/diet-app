// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { labelEntryFigures, readLabel, type LabelReading } from './label.js';

const reading = (given: Partial<LabelReading>): LabelReading => ({
  kcal: null,
  kj: null,
  protein: null,
  fat: null,
  carbs: null,
  fiber: null,
  sugars: null,
  salt: null,
  sodium: null,
  saturatedFat: null,
  alcohol: null,
  polyols: null,
  ...given,
});

/** Yoghurt: its energy is what its figures come to, within what a label rounds. */
const YOGHURT = { kcal: 60, protein: 3.2, fat: 3.2, carbs: 4.7 };

describe('what a label says', () => {
  it('is kept as it stands where it adds up', () => {
    expect(
      readLabel(reading({ ...YOGHURT, saturatedFat: 2.1, sugars: 4.7, salt: 0.0975 })),
    ).toEqual({
      calories: 60,
      protein: 3.2,
      fat: 3.2,
      carbs: 4.7,
      fiber: null,
      sugars: 4.7,
      salt: 0.1,
      saturatedFat: 2.1,
      energyWorkedOut: false,
      doubtful: false,
    });
  });

  it('takes the energy from kilojoules where it gives no kilocalories', () => {
    const label = readLabel(reading({ kj: 252.7, protein: 3.2, fat: 3.2, carbs: 4.7 }));
    expect(label.calories).toBe(60.4);
    expect(label.energyWorkedOut).toBe(false);
    expect(label.doubtful).toBe(false);
  });

  it('works the energy out of all three macronutrients where it gives none, and says so', () => {
    const label = readLabel(reading({ protein: 10, fat: 10, carbs: 10 }));
    expect(label.calories).toBe(170);
    expect(label.energyWorkedOut).toBe(true);
    expect(label.doubtful).toBe(false);
  });

  it('knows no energy where it gives neither energy nor all three macronutrients', () => {
    const label = readLabel(reading({ protein: 10, fat: 10 }));
    expect(label.calories).toBeNull();
    expect(label.energyWorkedOut).toBe(false);
  });

  it('takes salt from sodium where it gives no salt', () => {
    expect(readLabel(reading({ sodium: 0.4 })).salt).toBe(1);
  });

  it.each([
    ['over what pure fat holds', 1682],
    ['below nothing', -5],
  ])('takes the kilojoules for an energy %s, and does not doubt what then adds up', (_, kcal) => {
    expect(readLabel(reading({ ...YOGHURT, kcal, kj: 252.7 }))).toMatchObject({
      calories: 60.4,
      energyWorkedOut: false,
      doubtful: false,
    });
  });

  it('works the energy out where it cannot be right and no kilojoules are given', () => {
    // 4 x 3.2 + 9 x 3.2 + 4 x 4.7 = 60.4 kcal.
    expect(readLabel(reading({ ...YOGHURT, kcal: 1682 }))).toMatchObject({
      calories: 60.4,
      energyWorkedOut: true,
      doubtful: false,
    });
  });

  it('doubts an energy of kilojoules that does not add up either', () => {
    expect(readLabel(reading({ ...YOGHURT, kcal: 1682, kj: 1682 })).doubtful).toBe(true);
  });

  it.each([
    [
      'a macronutrient over 100 g in 100 g',
      { kcal: 590, protein: 25, fat: 156, carbs: 20 },
      { fat: null },
    ],
    [
      'a macronutrient below nothing',
      { kcal: 50, protein: -1, fat: 2, carbs: 5 },
      { protein: null },
    ],
    [
      'macronutrients over 100 g in 100 g together',
      { kcal: 620, protein: 20, fat: 17, carbs: 94 },
      { protein: null, fat: null, carbs: null },
    ],
  ])('counts as unknown, and as doubtful, %s', (_, given, kept) => {
    const label = readLabel(reading({ kj: 252.7, ...given }));
    expect(label).toMatchObject(kept);
    expect(label.doubtful).toBe(true);
  });

  it('drops a label nutrient that cannot be right, without doubting the rest', () => {
    const label = readLabel(reading({ ...YOGHURT, salt: 1000, sugars: 400 }));
    expect(label).toMatchObject({ salt: null, sugars: null, calories: 60, doubtful: false });
  });

  describe('is doubtful where its energy lies too far from what its figures come to', () => {
    it('both by 40 kcal and by a fifth', () => {
      // 4 x 8 + 4 x 62 + 9 x 20 = 460 kcal, where it says 176.
      expect(readLabel(reading({ kcal: 176, protein: 8, fat: 20, carbs: 62 })).doubtful).toBe(true);
    });

    it('not by a fifth of something small', () => {
      // 4 x 1 + 4 x 1 + 0 = 8 kcal, where it says 40: 32 kcal apart.
      expect(readLabel(reading({ kcal: 40, protein: 1, fat: 0, carbs: 1 })).doubtful).toBe(false);
    });

    it('not by 40 kcal of something large', () => {
      // 4 x 25 + 4 x 25 + 9 x 30 = 470 kcal, where it says 515: under a tenth apart.
      expect(readLabel(reading({ kcal: 515, protein: 25, fat: 30, carbs: 25 })).doubtful).toBe(
        false,
      );
    });

    it('not where the rest of the energy is the alcohol it names', () => {
      const vodka = { kcal: 231, protein: 0, fat: 0, carbs: 0 };
      expect(readLabel(reading(vodka)).doubtful).toBe(true);
      expect(readLabel(reading({ ...vodka, alcohol: 33 })).doubtful).toBe(false);
    });

    it('not where its carbohydrates are the polyols it names', () => {
      const gum = { kcal: 149, protein: 0, fat: 0, carbs: 62 };
      expect(readLabel(reading(gum)).doubtful).toBe(true);
      expect(readLabel(reading({ ...gum, polyols: 60 })).doubtful).toBe(false);
    });

    it('not where the rest of the energy is the fibre it names', () => {
      // 4 x 15 + 9 x 5 + 4 x 15 = 165 kcal, where it says 240; 30 g of fibre carry 60 more.
      const bran = { kcal: 240, protein: 15, fat: 5, carbs: 15 };
      expect(readLabel(reading(bran)).doubtful).toBe(true);
      expect(readLabel(reading({ ...bran, fiber: 30 })).doubtful).toBe(false);
    });
  });
});

describe('what an amount of a product comes to', () => {
  const split = { protein: 0.3, fat: 0.3, carbs: 0.4 };

  it('is its figures in proportion, with what the label says beside them', () => {
    const label = readLabel(reading({ ...YOGHURT, salt: 0.1, sugars: 4.7 }));
    expect(labelEntryFigures(label, 250, split)).toEqual({
      calories: 150,
      protein: 8,
      fat: 8,
      carbs: 11.75,
      fiber: null,
      sugars: 11.75,
      salt: 0.25,
      saturatedFat: null,
      estimated: false,
    });
  });

  it('stands as the label gives it where its figures do not add up', () => {
    const label = readLabel(reading({ kcal: 176, protein: 8, fat: 20, carbs: 62 }));
    expect(labelEntryFigures(label, 100, split)).toMatchObject({
      calories: 176,
      protein: 8,
      fat: 20,
      carbs: 62,
      estimated: false,
    });
  });

  it('estimates what the label lacks from what is left of the energy, and says so', () => {
    const label = readLabel(reading({ kcal: 100, protein: 5 }));
    const figures = labelEntryFigures(label, 100, split)!;
    expect(figures.protein).toBe(5);
    expect(figures.estimated).toBe(true);
    // What is left of the energy is shared by the two left out, in the split's proportions.
    expect(figures.fat * 9 + figures.carbs * 4).toBeCloseTo(80);
    expect(figures.fat * 9).toBeCloseTo(80 * (0.3 / 0.7));
  });

  it('gives what the label lacks nothing where the rest already carries all the energy', () => {
    const label = readLabel(reading({ kcal: 50, protein: 30 }));
    expect(labelEntryFigures(label, 100, split)).toMatchObject({
      calories: 50,
      protein: 30,
      fat: 0,
      carbs: 0,
      estimated: true,
    });
  });

  it('is an estimate where the energy was worked out', () => {
    const label = readLabel(reading({ protein: 10, fat: 10, carbs: 10 }));
    expect(labelEntryFigures(label, 100, split)).toMatchObject({ calories: 170, estimated: true });
  });

  it('cannot be counted without its energy', () => {
    const label = readLabel(reading({ protein: 10 }));
    expect(labelEntryFigures(label, 100, split)).toBeNull();
  });
});
