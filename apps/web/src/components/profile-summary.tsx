'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Flame, Target, UtensilsCrossed, Wheat } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { CalorieCalculation, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/stat-card';

const MACRO_COLORS = ['var(--color-primary)', 'var(--color-accent)', 'oklch(0.75 0.13 80)'];

/**
 * Calorie target, deficit and macro split for a single profile. The dashboard
 * renders one of these per profile, so each owns its own calorie query.
 */
export function ProfileSummary({ profile }: { profile: Profile }) {
  const calories = useQuery({
    queryKey: ['calories', profile.id],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${profile.id}/calories`),
  });

  const c = calories.data;
  const macroData = c
    ? [
        { name: 'Protein', value: c.targetMacros.protein },
        { name: 'Fat', value: c.targetMacros.fat },
        { name: 'Carbs', value: c.targetMacros.carbs },
      ]
    : [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{profile.name}</h2>
        <Link
          href={`/meal-plans?profile=${profile.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Generate meal plan
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          index={0}
          icon={Target}
          label="Daily target"
          value={c ? `${c.dailyTarget} kcal` : '—'}
          hint={c?.source === 'manual_override' ? 'Manually set' : 'Calculated'}
        />
        <StatCard index={1} icon={Flame} label="Maintenance" value={c ? `${c.maintenance} kcal` : '—'} />
        <StatCard index={2} icon={Wheat} label="Daily deficit" value={c ? `${c.dailyDeficit} kcal` : '—'} />
        <StatCard
          index={3}
          icon={UtensilsCrossed}
          label="Meals / day"
          value={String(profile.mealCount)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Target macro split</CardTitle>
        </CardHeader>
        <CardContent>
          {macroData.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={macroData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95}>
                    {macroData.map((_, i) => (
                      <Cell key={i} fill={MACRO_COLORS[i]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
