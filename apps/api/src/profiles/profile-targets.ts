// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Macros, TargetMacros } from '@diet-app/shared';
import { calculateCalories, macroSplitOf, ownSplit, proteinKcalOf } from '../engine/index.js';
import { calorieInputOf, type CalorieProfile } from './calorie-input.js';

/**
 * What a profile aims at on a day with no plan to go by, as the diary reads it: the day's calories, the grams of the
 * macros (with the least carbohydrate of a diet whose carbohydrate is a ceiling), the shares an estimate of the day
 * goes by, and the diet.
 */
export const HeldTarget = z.object({
  calories: z.number(),
  protein: z.number(),
  fat: z.number(),
  carbs: z.number(),
  carbsFloor: TargetMacros.shape.carbsFloor,
  split: Macros,
  dietType: z.string(),
});
export type HeldTarget = z.infer<typeof HeldTarget>;

/** The columns of a profile its target is worked out from: a write of any of them writes the target down. */
export const TARGET_COLUMNS = {
  age: true,
  sex: true,
  heightCm: true,
  weightKg: true,
  activityLevel: true,
  dietType: true,
  customMacroSplit: true,
  customProteinPerKg: true,
  weeklyLossTarget: true,
  manualCalorieTarget: true,
  expenditureCorrectionKcal: true,
} satisfies Record<keyof CalorieProfile, true>;

/** What [profile] aims at as it stands. */
export function targetOf(profile: CalorieProfile): HeldTarget {
  const input = calorieInputOf(profile);
  const calculation = calculateCalories(input);
  // The custom diet's split of the target: with the protein of its grams where it is per kilogram.
  const own =
    input.dietType === 'custom' && input.customMacroSplit
      ? ownSplit(
          input.customMacroSplit,
          input.customProteinPerKg != null
            ? proteinKcalOf(input.customProteinPerKg, input.weightKg)
            : null,
          calculation.dailyTarget,
        ).shares
      : null;
  return {
    calories: calculation.dailyTarget,
    ...calculation.targetMacros,
    split: macroSplitOf(input.dietType, own),
    dietType: input.dietType,
  };
}

/**
 * Writes down what the profile [profileId] aims at now, in force from [day], the client's day (the server's where it
 * names none): every write of a column of `TARGET_COLUMNS` calls it after the write, in the write's transaction. The
 * day's last change of it stands.
 */
export async function noteTarget(
  db: Pick<Prisma.TransactionClient, 'profile' | 'profileTarget'>,
  profileId: string,
  day: string | null,
): Promise<void> {
  const profile = await db.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: TARGET_COLUMNS,
  });
  const target = targetOf(profile);
  const from = new Date(day ?? new Date().toISOString().slice(0, 10));
  await db.profileTarget.upsert({
    where: { profileId_from: { profileId, from } },
    create: { profileId, from, target },
    update: { target },
  });
}

/** A row of what a profile aimed at, from its day on. */
export interface TargetFrom {
  from: string;
  target: HeldTarget;
}

/**
 * The rows of [profileId] that can be in force on a day up to [to], the earliest first: those from it on or before,
 * or its first where it has none so early. A row that does not read is passed over.
 */
async function targetsUpTo(
  db: Pick<Prisma.TransactionClient, 'profileTarget'>,
  profileId: string,
  to: string,
): Promise<TargetFrom[]> {
  const early = await db.profileTarget.findMany({
    where: { profileId, from: { lte: new Date(to) } },
    orderBy: { from: 'asc' },
    select: { from: true, target: true },
  });
  const rows =
    early.length > 0
      ? early
      : await db.profileTarget.findMany({
          where: { profileId },
          orderBy: { from: 'asc' },
          take: 1,
          select: { from: true, target: true },
        });
  return rows.flatMap((row) => {
    const target = HeldTarget.safeParse(row.target);
    return target.success
      ? [{ from: row.from.toISOString().slice(0, 10), target: target.data }]
      : [];
  });
}

/**
 * What [profileId] aimed at on [date]: the row in force on it, or its first where the day comes before its rows (a day
 * written before the profile was made); null where it has none.
 */
async function targetOn(
  db: Pick<Prisma.TransactionClient, 'profileTarget'>,
  profileId: string,
  date: string,
): Promise<HeldTarget | null> {
  const row =
    (await db.profileTarget.findFirst({
      where: { profileId, from: { lte: new Date(date) } },
      orderBy: { from: 'desc' },
      select: { target: true },
    })) ??
    (await db.profileTarget.findFirst({
      where: { profileId },
      orderBy: { from: 'asc' },
      select: { target: true },
    }));
  const target = HeldTarget.safeParse(row?.target ?? null);
  return target.success ? target.data : null;
}

/**
 * Of [rows], the earliest first, what was in force on [date]: the latest from on or before it, or the first where the
 * day comes before them all. Null where there are none, and the day then reads the profile as it stands.
 */
export function inForce(rows: readonly TargetFrom[], date: string): HeldTarget | null {
  let found: HeldTarget | null = rows[0]?.target ?? null;
  for (const row of rows) {
    if (row.from > date) break;
    found = row.target;
  }
  return found;
}

/** What a day gone that no plan holds aimed at: a removed plan's day's own target, or the profile's as it stood. */
export interface Held {
  target: HeldTarget;
  /** It is the target of a day of a plan removed since. */
  ofAPlan: boolean;
}

/** What the day [date] of [profileId], gone and held by no plan, aimed at; null where nothing is written down. */
export async function heldOn(
  db: Pick<Prisma.TransactionClient, 'profileTarget' | 'dayTarget'>,
  profileId: string,
  date: string,
): Promise<Held | null> {
  const day = await db.dayTarget.findUnique({
    where: { profileId_date: { profileId, date: new Date(date) } },
    select: { target: true },
  });
  const ofAPlan = HeldTarget.safeParse(day?.target ?? null);
  if (ofAPlan.success) return { target: ofAPlan.data, ofAPlan: true };
  const target = await targetOn(db, profileId, date);
  return target ? { target, ofAPlan: false } : null;
}

/** What the days of [profileId] from [from] to [to] that no plan holds aimed at, read once for them all. */
export interface HeldDays {
  days: Map<string, HeldTarget>;
  rows: TargetFrom[];
}

export async function heldOfDays(
  db: Pick<Prisma.TransactionClient, 'profileTarget' | 'dayTarget'>,
  profileId: string,
  from: string,
  to: string,
): Promise<HeldDays> {
  const [days, rows] = await Promise.all([
    db.dayTarget.findMany({
      where: { profileId, date: { gte: new Date(from), lte: new Date(to) } },
      select: { date: true, target: true },
    }),
    targetsUpTo(db, profileId, to),
  ]);
  return {
    days: new Map(
      days.flatMap((row) => {
        const target = HeldTarget.safeParse(row.target);
        return target.success ? [[row.date.toISOString().slice(0, 10), target.data] as const] : [];
      }),
    ),
    rows,
  };
}

/** Of [held], what the day [date] aimed at; null where nothing is written down. */
export function heldOfDay(held: HeldDays, date: string): Held | null {
  const day = held.days.get(date);
  if (day) return { target: day, ofAPlan: true };
  const target = inForce(held.rows, date);
  return target ? { target, ofAPlan: false } : null;
}
