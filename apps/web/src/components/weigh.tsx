// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AiGenerationMeta } from '@diet-app/shared';
import { AiMark } from '@/components/ai-mark';
import { Button } from '@/components/ui/button';

/**
 * The button that asks a model to weigh what the engine has proposed: to put
 * the proposals in order and say a sentence of each. On an account with no
 * model to ask it stays in its place, disabled, and names the line that says
 * why (`AiOffNote`), as everything that asks a model does.
 */
export function WeighButton({
  enabled,
  offNote,
  asking,
  onAsk,
}: {
  enabled: boolean;
  offNote: string | undefined;
  asking: boolean;
  onAsk: () => void;
}) {
  const t = useTranslations('weigh');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-primary"
      title={enabled ? t('tooltip') : undefined}
      aria-describedby={enabled ? undefined : offNote}
      disabled={asking || !enabled}
      onClick={onAsk}
    >
      <Sparkles size={14} aria-hidden />
      <span className="ml-1">{asking ? t('asking') : t('ask')}</span>
    </Button>
  );
}

/**
 * How asking a model went, said where the proposals are and read out: that a
 * model put them in order, or why the engine's order stands. Nothing when no
 * model was asked.
 */
export function WeighedLine({ aiMeta }: { aiMeta: AiGenerationMeta | null }) {
  const t = useTranslations('weigh');
  const tFallback = useTranslations('aiFallback');
  return (
    <p role="status" className={aiMeta ? 'text-xs text-muted-foreground' : 'sr-only'}>
      {aiMeta ? (aiMeta.fallbackReason ? tFallback(aiMeta.fallbackReason) : t('weighed')) : ''}
    </p>
  );
}

/** A model's sentence on one proposal, under the mark that a model said it. Nothing where it said none. */
export function ModelSays({ reason }: { reason: string | null }) {
  return reason ? <AiMark part={{ kind: 'weighed', reason }} spelledOut /> : null;
}
