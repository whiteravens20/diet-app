// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { figuresOf, riskOf } from '@/lib/typed-figures';
import { useProfileForm } from '@/lib/use-profile-form';
import { useWeightUnit } from '@/lib/weight-unit';
import { CaloriePreviewPanel, useCaloriePreview } from '@/components/calorie-preview';
import { BodyFields, DietFields, OwnTargetField, PaceChoice, RiskBox } from '@/components/profile-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The calculator: what a body, an activity, a pace and a diet come to in a
 * day, worked out as they are typed and never kept. It begins with the
 * figures of a profile of the account, to be changed and looked at ("what if
 * I moved more"), or with an empty form.
 */
export default function CalculatorPage() {
  const t = useTranslations('calculator');
  const unit = useWeightUnit();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const list = profiles.data ?? [];

  // Whose figures the form begins with: the first profile until one is picked, nobody's (null) when the empty form is.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const from = picked === undefined ? (list[0] ?? null) : (list.find((p) => p.id === picked) ?? null);
  // The form is made anew for whoever it begins with, and what was typed into another one is not this one's.
  const formKey = from?.id ?? 'empty';
  const { form, typed, onChange } = useProfileForm(formKey, unit);
  const risk = typed ? typed.reasons : from ? riskOf(from) : [];
  const shown = useCaloriePreview(typed ? typed.figures : from ? figuresOf(from) : null);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('subhead')}</p>
      </header>

      {/* The form waits for the profiles: one that began empty and then filled itself would take what was typed with it. */}
      {profiles.isLoading ? (
        <Skeleton className="h-96 max-w-4xl" />
      ) : (
        <>
          {list.length > 0 && (
            <div role="group" aria-label={t('startFrom')} className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('startFrom')}</span>
              {list.map((p) => (
                <Button key={p.id} type="button" size="sm" variant={from?.id === p.id ? 'primary' : 'outline'} aria-pressed={from?.id === p.id} onClick={() => setPicked(p.id)}>
                  {p.name}
                </Button>
              ))}
              <Button type="button" size="sm" variant={from === null ? 'primary' : 'outline'} aria-pressed={from === null} onClick={() => setPicked(null)}>
                {t('empty')}
              </Button>
            </div>
          )}

          <div className="grid max-w-4xl items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <Card>
              <CardContent className="pt-6">
                <form key={formKey} ref={form} aria-label={t('title')} onSubmit={(event) => event.preventDefault()} onChange={onChange} className="grid gap-4 sm:grid-cols-2">
                  <BodyFields initial={from ?? undefined} unit={unit} />
                  <DietFields diet={from?.dietType ?? 'balanced'} split={from?.customMacroSplit ?? null} meals={false} />
                  <PaceChoice initial={from ? from.weeklyLossTarget : '0.5'} paces={shown.preview?.paces} unit={unit} className="sm:col-span-2" />
                  <OwnTargetField initial={from?.manualCalorieTarget ?? null} />
                  <RiskBox reasons={risk} acknowledged={from?.riskAcknowledgedAt != null} kept={false} className="sm:col-span-2" />
                </form>
              </CardContent>
            </Card>

            <CaloriePreviewPanel {...shown} heading="h2" className="lg:sticky lg:top-6" />
          </div>

          <p className="max-w-2xl text-sm text-muted-foreground">
            {t.rich('notKept', {
              profiles: (words) => (
                <Link href="/profile" className="font-medium text-foreground underline underline-offset-2">
                  {words}
                </Link>
              ),
            })}
          </p>
        </>
      )}
    </div>
  );
}
