'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Profile, ProfileInput } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** Profile manager — create a profile and review existing ones. */
export default function ProfilePage() {
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: ProfileInput) => api.post<Profile>('/profiles', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
    onError: () => setError('Could not save the profile — check the values and try again.'),
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    create.mutate({
      name: String(f.get('name')),
      age: Number(f.get('age')),
      sex: (f.get('sex') as 'male' | 'female') || null,
      heightCm: Number(f.get('heightCm')),
      weightKg: Number(f.get('weightKg')),
      activityLevel: f.get('activityLevel') as ProfileInput['activityLevel'],
      dietType: f.get('dietType') as ProfileInput['dietType'],
      weeklyLossTarget: (f.get('weeklyLossTarget') as ProfileInput['weeklyLossTarget']) || null,
      manualCalorieTarget: f.get('manualCalorieTarget')
        ? Number(f.get('manualCalorieTarget'))
        : null,
      mealCount: Number(f.get('mealCount')),
      preferences: {
        excludedIngredientIds: [],
        allergens: [],
        dislikedFoods: [],
        preferredCuisines: [],
      },
    });
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your profile drives the deterministic calorie engine.
        </p>
      </header>

      {profiles.isLoading ? (
        <Skeleton className="h-24 max-w-2xl" />
      ) : (
        profiles.data &&
        profiles.data.length > 0 && (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            {profiles.data.map((p) => (
              <Card key={p.id} className="p-4">
                <p className="font-medium">{p.name}</p>
                <p className="text-sm text-muted-foreground">
                  {p.age} y · {p.heightCm} cm · {p.weightKg} kg · {p.dietType}
                </p>
              </Card>
            ))}
          </div>
        )
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>New profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input name="name" required placeholder="Default" />
            </Field>
            <Field label="Age">
              <Input name="age" type="number" required min={13} max={120} defaultValue={30} />
            </Field>
            <Field label="Sex">
              <select name="sex" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">Prefer not to say</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </Field>
            <Field label="Height (cm)">
              <Input name="heightCm" type="number" required min={100} max={250} defaultValue={175} />
            </Field>
            <Field label="Weight (kg)">
              <Input name="weightKg" type="number" required min={30} max={400} defaultValue={75} />
            </Field>
            <Field label="Activity level">
              <select
                name="activityLevel"
                defaultValue="moderate"
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="sedentary">Sedentary</option>
                <option value="light">Light</option>
                <option value="moderate">Moderate</option>
                <option value="active">Active</option>
                <option value="very_active">Very active</option>
              </select>
            </Field>
            <Field label="Diet type">
              <select
                name="dietType"
                defaultValue="balanced"
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                {['balanced', 'high_protein', 'low_carb', 'vegetarian', 'vegan', 'keto', 'mediterranean'].map(
                  (d) => (
                    <option key={d} value={d}>
                      {d.replace('_', ' ')}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Weekly loss target (kg)">
              <select
                name="weeklyLossTarget"
                defaultValue="0.5"
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="">Maintain</option>
                <option value="0.25">0.25</option>
                <option value="0.5">0.5</option>
                <option value="0.75">0.75</option>
                <option value="1.0">1.0</option>
              </select>
            </Field>
            <Field label="Manual kcal override (optional)">
              <Input name="manualCalorieTarget" type="number" min={800} max={6000} placeholder="auto" />
            </Field>
            <Field label="Meals per day">
              <Input name="mealCount" type="number" required min={2} max={5} defaultValue={3} />
            </Field>
            <div className="sm:col-span-2">
              {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Create profile'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
