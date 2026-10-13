// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What the calorie engine answers, for a component under test that shows it. */
import { PACES_OF_LOSS, type CalorieCalculation, type CaloriePreview } from '@diet-app/shared';

/** The calculation of a man of 30, 180 cm and 80 kg who moves moderately and loses half a kilogram a week; a test overrides what it is about. */
function aCalculation(over: Partial<CalorieCalculation> = {}): CalorieCalculation {
  return {
    bmr: 1780,
    maintenance: 2759,
    weeklyLossTarget: '0.5',
    requestedDeficit: 550,
    dailyDeficit: 550,
    dailyTarget: 2209,
    targetMacros: { protein: 138, fat: 74, carbs: 249 },
    source: 'calculated',
    safetyFloor: 1500,
    deficitCapped: false,
    safetyFloorApplied: false,
    maintenanceUnderFloor: false,
    goalHeld: false,
    warnings: [],
    ...over,
  };
}

/** What each pace comes to for that man: a quarter of his maintenance is the most a pace takes, which slows the two fastest. */
const AT_EACH_PACE = [2759, 2484, 2209, 2069, 2069];

/** What the API answers for typed figures: their calculation, and the same body at each pace. */
export function aPreview(calculation: Partial<CalorieCalculation> = {}): CaloriePreview {
  return {
    calculation: aCalculation(calculation),
    paces: PACES_OF_LOSS.map((pace, index) =>
      aCalculation({ weeklyLossTarget: pace, dailyTarget: AT_EACH_PACE[index]!, dailyDeficit: 2759 - AT_EACH_PACE[index]!, requestedDeficit: index * 275, deficitCapped: index > 2 }),
    ),
  };
}
