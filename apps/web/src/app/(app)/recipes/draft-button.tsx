// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * The button that opens the draft of a recipe by a model. Where the account
 * has no model to ask, it stays in its place, disabled, and says what it
 * waits for: on hover, and to a screen reader as its description.
 */
export function DraftButton({ aiEnabled, onOpen }: { aiEnabled: boolean; onOpen: () => void }) {
  const t = useTranslations('recipes');
  return (
    <span title={aiEnabled ? undefined : t('aiDraftOff')} className="inline-block">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpen}
        disabled={!aiEnabled}
        aria-describedby={aiEnabled ? undefined : 'ai-draft-off'}
        className="text-primary"
      >
        <Sparkles size={14} aria-hidden />
        <span className="ml-1">{t('aiDraft')}</span>
      </Button>
      {!aiEnabled && (
        <span id="ai-draft-off" className="sr-only">
          {t('aiDraftOff')}
        </span>
      )}
    </span>
  );
}
