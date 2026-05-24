'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Ingredient } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * A typeahead-style picker for ingredient ids — a chip list of the saved
 * entries plus a search box that suggests matches from the curated database.
 * The parent owns the ids; the picker only reads/writes that array.
 */
export function IngredientPicker({
  label,
  hint,
  ids,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  ids: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');

  // Names of saved ids — one query that updates whenever ids change.
  const saved = useQuery({
    queryKey: ['ingredients-by-ids', ids.join(',')],
    queryFn: () => (ids.length === 0 ? [] : api.get<Ingredient[]>(`/ingredients?ids=${ids.join(',')}`)),
  });

  const results = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });

  const idSet = new Set(ids);
  const available = (results.data ?? []).filter((i) => !idSet.has(i.id)).slice(0, 20);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>

      {(saved.data ?? []).length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {(saved.data ?? []).map((i) => (
            <li
              key={i.id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
            >
              {i.name}
              <button
                type="button"
                aria-label={`Remove ${i.name}`}
                className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                disabled={disabled}
                onClick={() => onChange(ids.filter((x) => x !== i.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground italic">None yet.</p>
      )}

      <div className="relative">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ingredients…"
          disabled={disabled}
        />
        {search.trim().length >= 2 && available.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
            {available.map((i) => (
              <li key={i.id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start rounded-none"
                  disabled={disabled}
                  onClick={() => {
                    onChange([...ids, i.id]);
                    setSearch('');
                  }}
                >
                  {i.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {search.trim().length >= 2 && available.length === 0 && !results.isLoading && (
          <p className="mt-1 text-xs text-muted-foreground">No matches.</p>
        )}
      </div>
    </div>
  );
}
