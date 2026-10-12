// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { AiOffNote } from '@/components/ai-off-note';
import { Button } from '@/components/ui/button';

/**
 * The button that opens the draft of a recipe by a model. Where the account
 * has no model to ask, it stays in its place, disabled, over a line that says
 * what it waits for.
 */
export function DraftButton({ aiEnabled, onOpen }: { aiEnabled: boolean; onOpen: () => void }) {
  const t = useTranslations('recipes');
  const note = useId();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpen}
        disabled={!aiEnabled}
        aria-describedby={aiEnabled ? undefined : note}
        className="text-primary"
      >
        <Sparkles size={14} aria-hidden />
        <span className="ml-1">{t('aiDraft')}</span>
      </Button>
      {!aiEnabled && <AiOffNote id={note} />}
    </div>
  );
}
