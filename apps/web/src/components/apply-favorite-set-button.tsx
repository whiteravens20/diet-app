'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { FavoriteSet, MealPlan } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * Plan-level "Apply set" action — pick a favourite set + one-or-more days,
 * POST the apply request, then invalidate the plans query so the parent
 * re-fetches with the rewritten meals. Self-contained: owns its popover state,
 * the sets query, and the mutation so the parent only renders the button.
 */
export function ApplyFavoriteSetButton({
  plan,
  profileId,
  disabled,
}: {
  plan: MealPlan;
  profileId: string;
  disabled?: boolean;
}) {
  const t = useTranslations('favoriteSets');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedSetId, setPickedSetId] = useState<string>('');
  const [selectedDays, setSelectedDays] = useState<Set<string>>(
    new Set(plan.days.map((d) => d.date)),
  );

  const setsQ = useQuery({
    queryKey: ['favorite-sets', profileId],
    queryFn: () => api.get<FavoriteSet[]>(`/favorite-sets?profileId=${profileId}`),
    enabled: open,
  });

  const apply = useMutation({
    mutationFn: ({ setId, dayDates }: { setId: string; dayDates: string[] }) =>
      api.post<MealPlan>(`/favorite-sets/${setId}/apply`, { planId: plan.id, dayDates }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meal-plans', profileId] });
      setOpen(false);
    },
    onError: (e) => setError(e instanceof ApiClientError ? e.message : t('errApply')),
  });

  const sets = setsQ.data ?? [];

  function toggleDay(date: string): void {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  function selectAllDays(): void {
    setSelectedDays(new Set(plan.days.map((d) => d.date)));
  }

  function onApply(): void {
    setError(null);
    if (!pickedSetId) {
      setError(t('applyPickSet'));
      return;
    }
    const dayDates = Array.from(selectedDays);
    if (dayDates.length === 0) {
      setError(t('applyPickDays'));
      return;
    }
    apply.mutate({ setId: pickedSetId, dayDates });
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={disabled}
      >
        {t('apply')}
      </Button>
    );
  }

  return (
    <div className="absolute right-4 top-14 z-10 w-80 rounded-md border border-border bg-card p-3 shadow-md">
      <label className="block space-y-1 text-sm">
        <span className="font-medium">{t('applyPickSet')}</span>
        <select
          value={pickedSetId}
          onChange={(e) => setPickedSetId(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
        >
          <option value="">—</option>
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">{t('applyPickDays')}</span>
          <button
            type="button"
            onClick={selectAllDays}
            className="text-xs text-primary hover:underline"
          >
            {t('applyAllDays')}
          </button>
        </div>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {plan.days.map((d) => (
            <li key={d.id}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedDays.has(d.date)}
                  onChange={() => toggleDay(d.date)}
                  className="h-4 w-4"
                />
                <span className="tabular-nums">{d.date}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          {t('cancel')}
        </Button>
        <Button type="button" size="sm" onClick={onApply} disabled={apply.isPending}>
          {t('applyConfirm')}
        </Button>
      </div>
    </div>
  );
}
