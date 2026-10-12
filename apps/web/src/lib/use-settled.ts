// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useState } from 'react';

/**
 * A value once it has stopped changing for `ms`: what was typed, when the
 * typing has paused. The value is compared as it is, so it is a string or a
 * number, not an object made anew with every render.
 */
export function useSettled<Value extends string | number | null>(value: Value, ms: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const pause = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(pause);
  }, [value, ms]);
  return settled;
}
