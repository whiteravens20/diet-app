'use client';

import { useQuery } from '@tanstack/react-query';
import { Flame, Target, UtensilsCrossed, Wheat } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { CalorieCalculation, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/stat-card';

const MACRO_COLORS = ['var(--color-primary)', 'var(--color-accent)', 'oklch(0.75 0.13 80)'];

/** Dashboard — calorie target, macro split and adherence at a glance. */
export default function DashboardPage() {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const primary = profiles.data?.[0];

  const calories = useQuery({
    queryKey: ['calories', primary?.id],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${primary!.id}/calories`),
    enabled: Boolean(primary),
  });

  if (profiles.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  if (!primary) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>Welcome to Diet App</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create your first profile to calculate your calorie target and generate a meal plan.
          </p>
        </CardContent>
      </Card>
    );
  }

  const c = calories.data;
  const macroData = c
    ? [
        { name: 'Protein', value: c.targetMacros.protein },
        { name: 'Fat', value: c.targetMacros.fat },
        { name: 'Carbs', value: c.targetMacros.carbs },
      ]
    : [];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Profile: {primary.name}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          index={0}
          icon={Target}
          label="Daily target"
          value={c ? `${c.dailyTarget} kcal` : '—'}
          hint={c?.source === 'manual_override' ? 'Manually set' : 'Calculated'}
        />
        <StatCard index={1} icon={Flame} label="Maintenance" value={c ? `${c.maintenance} kcal` : '—'} />
        <StatCard
          index={2}
          icon={Wheat}
          label="Daily deficit"
          value={c ? `${c.dailyDeficit} kcal` : '—'}
        />
        <StatCard index={3} icon={UtensilsCrossed} label="Meals / day" value={String(primary.mealCount)} />
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
    </div>
  );
}
