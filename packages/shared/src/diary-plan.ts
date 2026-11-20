// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { DiaryCopyResult, DiaryEntry } from './diary.js';
import { RebalanceResult } from './meal-plan.js';

/**
 * What a change of the diary did to the day of the plan the diary shows for it (`DiaryDay.plan`, the plan made last
 * where several hold the day): where the change is of today, the day is sized again with what the diary holds counted
 * as eaten, as a meal of one's own added to the plan sizes it, and answered as a plan's change is
 * (`RebalanceResult`). Null where the change is of another day or the day has no plan.
 */
const PlanChange = RebalanceResult.nullable();

/** An entry as it was written or changed (`POST /diary/entries`, `PATCH /diary/entries/:id`), with what it did to the plan. */
export const WrittenDiaryEntry = DiaryEntry.extend({ planChange: PlanChange });
export type WrittenDiaryEntry = z.infer<typeof WrittenDiaryEntry>;

/** What a copy into a day did (`POST /diary/copy`), with what it did to the plan. */
export const WrittenDiaryCopy = DiaryCopyResult.extend({ planChange: PlanChange });
export type WrittenDiaryCopy = z.infer<typeof WrittenDiaryCopy>;
