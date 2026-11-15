// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Input } from './input';

/**
 * A secret typed into a form, a password or a provider's key: its label, the field, an eye that shows what is typed
 * and hides it again, and what is said under it. The eye stands outside the label, so the field's name stays the
 * label alone; the hint and the error describe the field. Shown, the field is a text field, so nothing of it is ever
 * checked for spelling (a browser's spell check may send a text field to a server of its own). It is hidden again
 * when its form is sent, before the page's own handler reads it, and when the page goes to the background or away.
 */
export function PasswordField({
  label,
  hint,
  error,
  secret = 'password',
  className,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  /** What the eye names: a password, or a key of an AI provider. */
  secret?: 'password' | 'key';
} & Omit<ComponentProps<'input'>, 'type' | 'id' | 'ref'>) {
  const t = useTranslations('common');
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  // Said to a screen reader once the eye has been pressed, and only then.
  const [told, setTold] = useState(false);

  useEffect(() => {
    const own = field.current!;
    const form = own.form;
    const hide = () => {
      own.type = 'password';
      setShown(false);
    };
    const whenHidden = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    form?.addEventListener('submit', hide, { capture: true });
    document.addEventListener('visibilitychange', whenHidden);
    window.addEventListener('pagehide', hide);
    return () => {
      form?.removeEventListener('submit', hide, { capture: true });
      document.removeEventListener('visibilitychange', whenHidden);
      window.removeEventListener('pagehide', hide);
    };
  }, []);

  const said =
    secret === 'key'
      ? { show: t('showKey'), hide: t('hideKey'), shown: t('keyShown'), hidden: t('keyHidden') }
      : {
          show: t('showPassword'),
          hide: t('hidePassword'),
          shown: t('passwordShown'),
          hidden: t('passwordHidden'),
        };
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const described =
    [input['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <Input
          {...input}
          ref={field}
          id={id}
          type={shown ? 'text' : 'password'}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          aria-describedby={described}
          className={cn('pr-11 [&::-ms-reveal]:hidden', className)}
        />
        <button
          type="button"
          aria-controls={id}
          aria-label={shown ? said.hide : said.show}
          disabled={input.disabled}
          // The press leaves the focus in the field: a phone's keyboard stays up.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setShown((now) => !now);
            setTold(true);
          }}
          className={cn(
            'absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md',
            'text-muted-foreground hover:text-foreground focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {shown ? (
            <EyeOff aria-hidden className="h-4 w-4" />
          ) : (
            <Eye aria-hidden className="h-4 w-4" />
          )}
        </button>
      </div>
      <span role="status" className="sr-only">
        {told ? (shown ? said.shown : said.hidden) : ''}
      </span>
      {hint && (
        <span id={hintId} className="block text-xs text-muted-foreground">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" className="block text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
