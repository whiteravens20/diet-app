'use client';

import { useQuery } from '@tanstack/react-query';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileSummary } from '@/components/profile-summary';

/** Dashboard — calorie target, macro split and adherence for every profile. */
export default function DashboardPage() {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });

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

  const list = profiles.data ?? [];

  if (list.length === 0) {
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

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {list.length === 1
            ? 'Your calorie target and macro split.'
            : `Calorie targets across your ${list.length} profiles.`}
        </p>
      </header>

      {list.map((p) => (
        <ProfileSummary key={p.id} profile={p} />
      ))}
    </div>
  );
}
