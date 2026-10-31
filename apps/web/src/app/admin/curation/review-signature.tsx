// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** The name the queue's decisions are recorded under: asked for once, above the list, and kept in this browser. */
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';

const STORED = 'admin.reviewSignature';

function read(): string {
  try {
    return window.localStorage.getItem(STORED) ?? '';
  } catch {
    return '';
  }
}

function write(value: string): void {
  try {
    window.localStorage.setItem(STORED, value);
  } catch {
    // It is asked for again next time.
  }
}

interface Signature {
  value: string;
  change: (value: string) => void;
  /** Whether a decision was refused for the want of it. */
  wanted: boolean;
  fieldId: string;
  /** The name to record a decision under. Without one the field says so and takes the focus, and this is null. */
  take: () => string | null;
}

const SignatureContext = createContext<Signature | null>(null);

export function ReviewSignature({ children }: { children: ReactNode }) {
  const fieldId = useId();
  // The queue is rendered once the panel has asked for its session and never on the server.
  const [value, setValue] = useState(read);
  const [wanted, setWanted] = useState(false);

  const change = useCallback((next: string) => {
    setValue(next);
    setWanted(false);
    write(next);
  }, []);

  const take = useCallback(() => {
    const name = value.trim();
    if (name) return name;
    setWanted(true);
    document.getElementById(fieldId)?.focus();
    return null;
  }, [value, fieldId]);

  const signature = useMemo(
    () => ({ value, change, wanted, fieldId, take }),
    [value, change, wanted, fieldId, take],
  );
  return <SignatureContext.Provider value={signature}>{children}</SignatureContext.Provider>;
}

export function useReviewSignature(): Signature {
  const signature = useContext(SignatureContext);
  if (!signature) throw new Error('useReviewSignature outside ReviewSignature');
  return signature;
}

export function SignatureField() {
  const t = useTranslations('admin.curation');
  const { value, change, wanted, fieldId } = useReviewSignature();
  const noteId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={fieldId} className="text-muted-foreground">
        {t('signatureLabel')}
      </label>
      <Input
        id={fieldId}
        value={value}
        onChange={(event) => change(event.target.value)}
        maxLength={80}
        autoComplete="off"
        aria-invalid={wanted || undefined}
        aria-describedby={noteId}
        className="h-8 w-48"
      />
      {wanted ? (
        <span id={noteId} role="alert" className="text-destructive">
          {t('signatureNeeded')}
        </span>
      ) : (
        <span id={noteId} className="text-muted-foreground">
          {t('signatureHint')}
        </span>
      )}
    </div>
  );
}
