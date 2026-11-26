// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { CalorieCalculation } from '@diet-app/shared';
import { OLDER_FASTEST_PACE_KG } from '@diet-app/shared/constants';
import { useFormat } from '@/lib/use-format';
import { shownWeight, useWeightUnit } from '@/lib/weight-unit';

/**
 * What stands behind a calorie target that is not simply maintenance less the
 * chosen pace: a goal that is held, a pace that was slowed, a floor, and the
 * warnings for somebody under 18 or underweight. A form that gives those
 * warnings itself, with the box that answers them, asks for the rest alone
 * (`risk` false).
 */
export function TargetNotices({
  calories: c,
  risk = true,
}: {
  calories: CalorieCalculation;
  risk?: boolean;
}) {
  const t = useTranslations('profileSummary.notices');
  const fmt = useFormat();
  const unit = useWeightUnit();
  // A weight is said as the paces to choose from say it: to the hundredth in kilograms, to the tenth in pounds.
  const amountOf = (kg: number): string =>
    unit === 'lb' ? fmt.unit(shownWeight(kg, unit), 'pound', 1) : fmt.unit(kg, 'kilogram', 2);
  const notices: { key: string; text: string; strong: boolean }[] = [];
  const say = (key: string, strong = false) =>
    notices.push({
      key,
      strong,
      text: t(key, {
        floor: c.safetyFloor,
        requested: c.requestedDeficit,
        deficit: c.dailyDeficit,
        bmr: c.bmr,
        maintenance: c.maintenance,
        target: c.dailyTarget,
        pace: amountOf(c.weeklyLossKg),
        // From 65 the faster paces count as the fastest a plan keeps.
        amount: amountOf(OLDER_FASTEST_PACE_KG),
      }),
    });

  if (risk && c.goalHeld) say('goalHeld', true);
  for (const warning of c.warnings)
    if (risk && (warning === 'minor' || warning === 'underweight')) say(warning, true);
  if (risk && c.warnings.includes('older') && c.dailyDeficit > 0) say('older');
  if (c.paceHeldForAge) say('paceHeldForAge');
  if (c.maintenanceUnderFloor) say('maintenanceUnderFloor');
  if (c.safetyFloorApplied) say('safetyFloorApplied');
  // Under the floor the pace is not what set the target: the floor did.
  if (c.deficitCapped && !c.safetyFloorApplied && !c.maintenanceUnderFloor && !c.goalHeld)
    say('deficitCapped');
  if (c.correctionHeld) say('correctionHeld');
  if (c.warnings.includes('below_floor')) say('below_floor', true);
  if (c.warnings.includes('below_bmr') && c.source === 'manual_override') say('below_bmr');
  if (notices.length === 0) return null;
  return (
    <ul className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
      {notices.map((notice) => (
        <li key={notice.key} className={notice.strong ? 'font-medium' : 'text-muted-foreground'}>
          {notice.text}
        </li>
      ))}
    </ul>
  );
}
