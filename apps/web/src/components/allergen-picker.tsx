'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Allergen } from '@diet-app/shared';

const ALLERGENS = Allergen.options;

/**
 * A dropdown-with-checkboxes picker for the profile allergen list. The list is
 * the fixed `Allergen` enum (not searched from the DB like ingredients), so a
 * compact closed control that opens a checkbox panel keeps all nine flags one
 * click away. Selected flags also render as chips under the control so the
 * profile's allergens stay readable at a glance without opening the dropdown.
 * The parent owns the array; the picker only reads/writes it.
 */
export function AllergenPicker({
  label,
  hint,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  selected: Allergen[];
  onChange: (allergens: Allergen[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('pickers');
  const tAllergen = useTranslations('enums.allergen');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on click outside / Escape so the panel doesn't linger over the form.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);

  function toggle(a: Allergen) {
    onChange(selectedSet.has(a) ? selected.filter((x) => x !== a) : [...selected, a]);
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>

      <div className="relative" ref={root}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-background px-3 text-left text-sm disabled:opacity-50"
        >
          <span className={selected.length === 0 ? 'text-muted-foreground' : ''}>
            {selected.length === 0
              ? t('allergensPlaceholder')
              : t('allergensSelected', { count: selected.length })}
          </span>
          <span aria-hidden className="ml-2 text-muted-foreground">
            {open ? '▲' : '▾'}
          </span>
        </button>

        {open && (
          <ul
            role="listbox"
            aria-label={label}
            className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-background p-1 shadow-md"
          >
            {ALLERGENS.map((a) => (
              <li key={a}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={selectedSet.has(a)}
                    disabled={disabled}
                    onChange={() => toggle(a)}
                  />
                  {tAllergen(a)}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((a) => (
            <li
              key={a}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
            >
              {tAllergen(a)}
              <button
                type="button"
                aria-label={t('remove', { name: tAllergen(a) })}
                className="hover:text-destructive disabled:opacity-50"
                disabled={disabled}
                onClick={() => toggle(a)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t('noneYet')}</p>
      )}
    </div>
  );
}
