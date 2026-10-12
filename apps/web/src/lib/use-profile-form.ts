// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CaloriePreviewRequest, WeightUnit } from '@diet-app/shared';
import { figuresIn, riskIn, type Risk } from './typed-figures';

/** What a profile form held when it was last read. */
export interface TypedForm {
  /** The figures a calorie target is worked out from; null while they are not ones the API would take. */
  figures: CaloriePreviewRequest | null;
  /** Why losing weight is a risk for the body they describe, when a loss is asked for. */
  reasons: Risk[];
}

/**
 * What a profile form holds, read each time one of its fields changes. The
 * form is read once it has drawn what the change brings with it: the fields
 * of the custom diet's split come and go with the diet, and a reading taken
 * in the middle of that change would miss them.
 *
 * `formKey` names the form. What was typed into another one (the form of
 * another profile) is not this one's: `typed` is null until this one is
 * typed into, and whoever shows the form falls back on what it began with.
 */
export function useProfileForm(formKey: string, unit: WeightUnit): { form: RefObject<HTMLFormElement | null>; typed: TypedForm | null; onChange: () => void } {
  const form = useRef<HTMLFormElement>(null);
  const [changed, setChanged] = useState<{ form: string; times: number } | null>(null);
  const [read, setRead] = useState<(TypedForm & { form: string }) | null>(null);
  useEffect(() => {
    if (changed && form.current) setRead({ form: changed.form, figures: figuresIn(form.current, unit), reasons: riskIn(form.current, unit) });
  }, [changed, unit]);
  return {
    form,
    typed: read?.form === formKey ? read : null,
    onChange: () => setChanged((before) => ({ form: formKey, times: (before?.times ?? 0) + 1 })),
  };
}
