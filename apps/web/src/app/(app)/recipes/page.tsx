'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** Recipe library — search and browse; each card opens the full recipe. */
export default function RecipesPage() {
  const [search, setSearch] = useState('');
  const recipes = useQuery({
    queryKey: ['recipes', search],
    queryFn: () =>
      api.get<Recipe[]>(`/recipes${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });
  const list = recipes.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-sm text-muted-foreground">
          The curated recipe library — every calorie and macro is computed from the database.
        </p>
      </header>

      <div className="max-w-sm">
        <Field label="Search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recipe title…"
          />
        </Field>
      </div>

      {recipes.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recipes match “{search}”.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => (
            <Link key={r.id} href={`/recipes/${r.id}`}>
              <Card className="h-full p-4 transition-shadow hover:shadow-md">
                <p className="font-medium">{r.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {r.nutritionPerServing.calories} kcal · {r.difficulty} ·{' '}
                  {r.prepMinutes + r.cookMinutes} min
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.dietTags.map((d) => (
                    <span
                      key={d}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {d.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
