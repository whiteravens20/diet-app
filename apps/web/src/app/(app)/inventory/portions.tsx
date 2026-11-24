// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { DisplayUnit, InventoryItem, InventoryPortion, Unit } from '@diet-app/shared';
import { FROZEN_KEEPS_DAYS } from '@diet-app/shared/constants';
import { MAX_PORTIONS, portionsOf } from '@diet-app/shared/portions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FreezingTips } from '@/components/freezing-tips';
import { api } from '@/lib/api';
import { useAmount, useShownAmount } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';

/** A number of portions as it is typed, or null where it is none the freezer takes. */
export function portionCount(typed: string): number | null {
  const count = Number(typed);
  return Number.isInteger(count) && count >= 1 && count <= MAX_PORTIONS ? count : null;
}

/** Whether `quantity` goes into `portions` packages of at least one of its unit each. */
export const portionsFit = (quantity: number, portions: number): boolean =>
  portionsOf(quantity, portions) !== null;

/**
 * What each package holds when `quantity` of `unit` goes into the freezer in `portions`, rounded as the pantry
 * shows it, or why it cannot be split so: a count the freezer does not take, or parts of less than one of the unit.
 * Nothing where there is one package or nothing to split yet.
 */
export function PortionsLine({
  id,
  quantity,
  unit,
  shownUnit,
  portions,
}: {
  id: string;
  quantity: number;
  unit: Unit;
  /** What a piece is called, for what is counted. */
  shownUnit: DisplayUnit;
  portions: number | null;
}) {
  const t = useTranslations('inventory');
  const tErrors = useTranslations('errors');
  const amount = useAmount();
  const fmt = useFormat();
  // Said in our words, and not left to the browser's, which speak its own language.
  if (portions === null)
    return (
      <p id={id} className="text-xs text-destructive">
        {t('portionsBound', { max: MAX_PORTIONS })}
      </p>
    );
  if (!(quantity > 0) || portions < 2) return null;
  const parts = portionsOf(quantity, portions);
  if (parts === null)
    return (
      <p id={id} className="text-xs text-destructive">
        {tErrors('PORTIONS_TOO_MANY')}
      </p>
    );
  // Pieces to the half, the rest to the gram or millilitre, as each package will stand on the list.
  const shown = parts.map((part) =>
    amount(unit === 'piece' ? Math.round(part * 2) / 2 : Math.round(part), shownUnit),
  );
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {new Set(shown).size === 1
        ? t('portionsEach', { count: portions, amount: shown[0]! })
        : t('portionsList', { amounts: fmt.list(shown) })}
    </p>
  );
}

/**
 * The window a fresh row goes into the freezer from: whole, or split into portions, each a package of its own
 * dated as the freezer keeps it. Under its intro, the size the profile's plans would take the packages out in, once
 * the server has said it, and the rules of freezing.
 */
export function FreezeDialog({
  item,
  busy,
  error,
  onFreeze,
  onClose,
}: {
  item: InventoryItem;
  busy: boolean;
  /** Why the last try did not go through, in the reader's words. */
  error: string | null;
  onFreeze: (portions: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const shownAmount = useShownAmount();
  const [typed, setTyped] = useState('1');
  const fieldId = useId();
  const lineId = useId();
  const portions = portionCount(typed);
  // A count the freezer does not take, or one that makes portions of less than one of the unit, is said under the
  // field, and nothing goes.
  const fits = portions !== null && portionsFit(item.quantity, portions);
  // A hint: while it is asked for, or where it cannot be had, the window goes on without it.
  const planned = useQuery({
    queryKey: ['inventory-portion', item.id],
    queryFn: () => api.get<InventoryPortion>(`/inventory/${item.id}/portion`),
  });
  // Said where it splits the row: a row no bigger than the portion goes in whole as it is.
  const portion =
    planned.data?.portion != null &&
    (planned.data.unit !== item.unit || item.quantity > planned.data.portion)
      ? planned.data.portion
      : null;
  return (
    <Dialog open onClose={onClose} label={t('freeze')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{t('freeze')}</h2>
          <p className="break-words text-xs text-muted-foreground">
            {fmt.text(item.ingredient.name)}, {shownAmount(item.display)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (portions !== null && fits) onFreeze(portions);
        }}
      >
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {t('freezeIntro', { days: FROZEN_KEEPS_DAYS })}
          </p>
          <FreezingTips portion={portion} unit={planned.data?.unit ?? item.unit} of="plans" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className="block text-xs font-medium text-muted-foreground">
            {t('portionsLabel')}
          </label>
          <Input
            id={fieldId}
            type="number"
            inputMode="numeric"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-invalid={!fits || undefined}
            aria-describedby={lineId}
            className="w-24"
          />
          <PortionsLine
            id={lineId}
            quantity={item.quantity}
            unit={item.unit}
            shownUnit={item.display.unit}
            portions={portions}
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !fits}>
            {t('freeze')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
