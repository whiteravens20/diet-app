// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Field, Input } from '@/components/ui/input';

/**
 * The code of the second step, named `code` in its form: the six digits of
 * the authenticator app, typed on a number pad, or a recovery code of letters
 * and digits, which the link under the field turns it into, and back.
 */
export function SecondStepCode({ autoFocus = false }: { autoFocus?: boolean }) {
  const t = useTranslations('secondFactor');
  const [recovery, setRecovery] = useState(false);
  const [switched, setSwitched] = useState(false);
  return (
    <div className="space-y-1">
      <Field label={t(recovery ? 'recoveryCode' : 'code')}>
        <Input
          // Another field for the other kind of code: what was typed for one is no use for the other.
          key={recovery ? 'recovery' : 'app'}
          name="code"
          required
          autoFocus={autoFocus || switched}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete={recovery ? 'off' : 'one-time-code'}
          autoCapitalize={recovery ? 'characters' : 'off'}
          maxLength={40}
        />
      </Field>
      <button
        type="button"
        className="text-sm text-muted-foreground hover:underline"
        onClick={() => {
          setRecovery((was) => !was);
          setSwitched(true);
        }}
      >
        {t(recovery ? 'useAppCode' : 'useRecoveryCode')}
      </button>
    </div>
  );
}
