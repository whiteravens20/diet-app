// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { PLAN_RELAXATIONS, type DayOverride, type FavoriteSet, type MealType, type PlanRelaxation } from '@diet-app/shared';
import { MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { useFormat } from '@/lib/use-format';

/** A favourite recipe usable as a lock target. */
export interface LockableRecipe {
  id: string;
  title: string;
  mealTypes: string[];
}

/** Per-day draft held in the form (strings/enums collapsed into request shape on submit). */
export interface DayDraft {
  mealCount?: number;
  calorieTarget?: number;
  dayKind?: 'normal' | 'rest' | 'training' | 'skip';
  cookTimeBudgetMinutes?: number;
  useUpBy?: boolean;
  /** The favourite set whose recipes fill the meals of the day that it has a recipe for. */
  setId?: string;
  lockSlot?: MealType;
  lockRecipeId?: string;
}

export interface AdvancedValue {
  maxRepeats?: number;
  /** The limits that may give way when no recipe is left inside them. */
  mayGiveWay?: PlanRelaxation[];
  days: Record<string, DayDraft>;
}

const KINDS: NonNullable<DayDraft['dayKind']>[] = ['normal', 'rest', 'training', 'skip'];

/**
 * The recipes a day is given before the plan is made: those of its favourite
 * set for the meals the day has, and the meal locked by hand, which goes
 * before the set's recipe for the same meal.
 */
function locksOf(d: DayDraft, sets: readonly FavoriteSet[], defaultMealCount: number): NonNullable<DayOverride['lockedSlots']> {
  const meals = MEAL_SLOTS_BY_COUNT[d.mealCount ?? defaultMealCount] ?? [];
  const locked = new Map<MealType, string>();
  const set = sets.find((one) => one.id === d.setId);
  for (const meal of meals) {
    const recipeId = set?.slots[meal];
    if (recipeId) locked.set(meal, recipeId);
  }
  if (d.lockSlot && d.lockRecipeId) locked.set(d.lockSlot, d.lockRecipeId);
  return [...locked].map(([mealType, recipeId]) => ({ mealType, recipeId }));
}

/** Collapse the form draft into the request's `maxRepeatsPerRecipe`, `allowRelaxations` and `dayOverrides`. */
export function buildAdvancedRequest(
  value: AdvancedValue,
  dates: string[],
  /** The profile's favourite sets, and how many meals a day of the plan has unless the day says otherwise. */
  sets: readonly FavoriteSet[] = [],
  defaultMealCount = 3,
): { maxRepeatsPerRecipe?: number; allowRelaxations?: PlanRelaxation[]; dayOverrides?: DayOverride[] } {
  const dayOverrides: DayOverride[] = [];
  for (const date of dates) {
    const d = value.days[date];
    if (!d) continue;
    const o: DayOverride = { date };
    if (d.mealCount) o.mealCount = d.mealCount;
    if (d.calorieTarget) o.calorieTarget = d.calorieTarget;
    if (d.cookTimeBudgetMinutes) o.cookTimeBudgetMinutes = d.cookTimeBudgetMinutes;
    if (d.useUpBy) o.useUpBy = true;
    if (d.dayKind === 'skip') o.skip = true;
    else if (d.dayKind === 'rest' || d.dayKind === 'training') o.dayType = d.dayKind;
    // A day that is skipped has no meal to lock: what was picked before the day was switched to skip is left out.
    const locks = d.dayKind === 'skip' ? [] : locksOf(d, sets, defaultMealCount);
    if (locks.length > 0) o.lockedSlots = locks;
    // Only send a day that actually carries an override beyond its date.
    if (Object.keys(o).length > 1) dayOverrides.push(o);
  }
  return {
    maxRepeatsPerRecipe: value.maxRepeats || undefined,
    allowRelaxations: value.mayGiveWay?.length ? value.mayGiveWay : undefined,
    dayOverrides: dayOverrides.length > 0 ? dayOverrides : undefined,
  };
}

const inputCls =
  'rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

export function AdvancedOptions({
  dates,
  defaultMealCount,
  favorites,
  sets,
  defaultMaxRepeats,
  value,
  onChange,
}: {
  dates: string[];
  defaultMealCount: number;
  favorites: LockableRecipe[];
  /** The profile's favourite sets: a day can be filled from one. */
  sets: readonly FavoriteSet[];
  /** The most a recipe repeats in a plan that names no number, where the operator set one. */
  defaultMaxRepeats: number | null;
  value: AdvancedValue;
  onChange: (next: AdvancedValue) => void;
}) {
  const t = useTranslations('mealPlans.advanced');
  const tLimit = useTranslations('mealPlans.limit');
  const tMeal = useTranslations('enums.mealType');
  const fmt = useFormat();

  // What an empty field stands for: the operator's number, or no limit beyond the profile's.
  const most = defaultMaxRepeats ?? 'none';

  const patchDay = (date: string, patch: Partial<DayDraft>) =>
    onChange({ ...value, days: { ...value.days, [date]: { ...value.days[date], ...patch } } });

  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">
        {t('toggle')}
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('hint')}</p>

        <div className="rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium">{t('legendTitle')}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <li>{t('legendDayKind')}</li>
            <li>{t('legendMeals')}</li>
            <li>{t('legendCalories')}</li>
            <li>{t('legendCookTime')}</li>
            <li>{t('legendUseUpBy')}</li>
            <li>{t('legendSet')}</li>
            <li>{t('legendLock')}</li>
            <li>{t('legendVariety', { most })}</li>
          </ul>
        </div>

        <div>
          <label className="block text-sm font-medium" htmlFor="adv-maxRepeats">
            {t('varietyFloor')}
          </label>
          <input
            id="adv-maxRepeats"
            type="number"
            min={1}
            max={28}
            className={`${inputCls} mt-1 w-24`}
            placeholder={defaultMaxRepeats === null ? undefined : String(defaultMaxRepeats)}
            value={value.maxRepeats ?? ''}
            onChange={(e) =>
              onChange({ ...value, maxRepeats: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('varietyFloorHint', { most })}</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">{t('mayGiveWay')}</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {PLAN_RELAXATIONS.map((kind) => (
              <label key={kind} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={value.mayGiveWay?.includes(kind) ?? false}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      mayGiveWay: PLAN_RELAXATIONS.filter((other) => (other === kind ? e.target.checked : value.mayGiveWay?.includes(other))),
                    })
                  }
                />
                {tLimit(kind)}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('mayGiveWayHint')}</p>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('perDay')}</legend>
          <div className="space-y-2">
            {dates.map((date) => {
              const d = value.days[date] ?? {};
              const mealCount = d.mealCount ?? defaultMealCount;
              const slots = MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!;
              const skipped = d.dayKind === 'skip';
              const lockFavorites = d.lockSlot
                ? favorites.filter((f) => f.mealTypes.includes(d.lockSlot!))
                : [];
              return (
                <div
                  key={date}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2 text-sm"
                >
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{fmt.day(date)}</span>

                  {/* Day kind (normal / rest / refeed / skip) */}
                  <select
                    aria-label={t('dayKind')}
                    className={inputCls}
                    value={d.dayKind ?? 'normal'}
                    onChange={(e) =>
                      patchDay(date, { dayKind: e.target.value as DayDraft['dayKind'] })
                    }
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`kind${k[0]!.toUpperCase()}${k.slice(1)}` as never)}
                      </option>
                    ))}
                  </select>

                  {/* Everything else is meaningless on a skipped day. */}
                  {!skipped && (
                    <>
                      <select
                        aria-label={t('mealCount')}
                        className={inputCls}
                        value={d.mealCount ?? ''}
                        onChange={(e) =>
                          patchDay(date, {
                            mealCount: e.target.value ? Number(e.target.value) : undefined,
                            lockSlot: undefined,
                            lockRecipeId: undefined,
                          })
                        }
                      >
                        <option value="">{`${t('mealCount')}: ${t('useDefault')}`}</option>
                        {[2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {`${t('mealCount')}: ${n}`}
                          </option>
                        ))}
                      </select>

                      <input
                        type="number"
                        min={800}
                        max={6000}
                        placeholder={t('calories')}
                        aria-label={t('calories')}
                        className={`${inputCls} w-24`}
                        value={d.calorieTarget ?? ''}
                        onChange={(e) =>
                          patchDay(date, {
                            calorieTarget: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />

                      <input
                        type="number"
                        min={0}
                        max={600}
                        placeholder={t('cookTime')}
                        aria-label={t('cookTime')}
                        className={`${inputCls} w-28`}
                        value={d.cookTimeBudgetMinutes ?? ''}
                        onChange={(e) =>
                          patchDay(date, {
                            cookTimeBudgetMinutes: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                      />

                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={d.useUpBy ?? false}
                          onChange={(e) => patchDay(date, { useUpBy: e.target.checked })}
                        />
                        {t('useUpBy')}
                      </label>

                      {/* Fill the day from a favourite set. Offered when there is one. */}
                      {sets.length > 0 && (
                        <select
                          aria-label={t('favoriteSet')}
                          className={inputCls}
                          value={d.setId ?? ''}
                          onChange={(e) => patchDay(date, { setId: e.target.value || undefined })}
                        >
                          <option value="">{`${t('favoriteSet')}: ${t('favoriteSetNone')}`}</option>
                          {sets.map((set) => (
                            <option key={set.id} value={set.id}>
                              {`${t('favoriteSet')}: ${set.label}`}
                            </option>
                          ))}
                        </select>
                      )}

                      {/* Lock a recipe to a slot */}
                      <select
                        aria-label={t('lockSlot')}
                        className={inputCls}
                        value={d.lockSlot ?? ''}
                        onChange={(e) =>
                          patchDay(date, {
                            lockSlot: (e.target.value || undefined) as MealType | undefined,
                            lockRecipeId: undefined,
                          })
                        }
                      >
                        <option value="">{`${t('lockSlot')}: ${t('lockNone')}`}</option>
                        {slots.map((s) => (
                          <option key={s} value={s}>
                            {tMeal(s)}
                          </option>
                        ))}
                      </select>

                      {d.lockSlot &&
                        (lockFavorites.length > 0 ? (
                          <select
                            aria-label={t('lockRecipe')}
                            className={inputCls}
                            value={d.lockRecipeId ?? ''}
                            onChange={(e) =>
                              patchDay(date, { lockRecipeId: e.target.value || undefined })
                            }
                          >
                            <option value="">{t('lockRecipePlaceholder')}</option>
                            {lockFavorites.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.title}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t('noFavoritesForLock')}
                          </span>
                        ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      </div>
    </details>
  );
}
