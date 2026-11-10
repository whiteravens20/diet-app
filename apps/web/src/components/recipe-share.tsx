// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { FileDown, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { PlannedIngredient, Recipe } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { CopyByHand } from '@/components/copy-by-hand';
import { copyText } from '@/lib/clipboard';
import { DOT } from '@/lib/figure-line';
import { useShownAmount } from '@/lib/ingredient-format';
import { fileNameOf, recipeText, type SharedRecipe } from '@/lib/recipe-share';
import { saveFile } from '@/lib/save-file';

/**
 * Whether what is shared goes to the system's sheet of apps: on a phone or a
 * tablet whose browser has one. A computer copies the text and saves the
 * document instead, to be pasted or attached where the user writes.
 */
function sheetOffered(): boolean {
  return (
    typeof navigator.share === 'function' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** That the user closed the sheet without sending anything: nothing went wrong. */
const dismissed = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

/**
 * The ways to send a recipe to somebody who is to cook it: as a text and as
 * a PDF, both made on the page. They hold what the recipe is opened with:
 * `amounts` and `servings` of a meal of a plan, where it was opened from one,
 * or the recipe's own. Nothing is published and no address is made: what is
 * sent goes where the user sends it.
 */
export function RecipeShare({
  recipe,
  amounts,
  servings,
}: {
  recipe: Recipe;
  amounts?: PlannedIngredient[];
  servings?: number;
}) {
  const t = useTranslations('recipeShare');
  const tDetail = useTranslations('recipeDetail');
  const tCommon = useTranslations('common');
  const shownAmount = useShownAmount();
  const labelId = useId();
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const [byHand, setByHand] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  const shared = (): SharedRecipe => {
    const source = recipe.source;
    return {
      title: recipe.title,
      ingredientsHeading: t('ingredientsFor', { servings: servings ?? recipe.servings }),
      ingredients: (amounts ?? recipe.ingredients).map((line) => ({
        name: line.name,
        amount: shownAmount(line.display),
        note: line.note,
      })),
      stepsHeading: tDetail('method'),
      steps: recipe.steps,
      notes: [
        ...(source
          ? [
              [
                ...(source.url && /^https?:\/\//i.test(source.url)
                  ? [t('source', { address: source.url })]
                  : []),
                t('licence', { licence: source.license }),
              ].join(DOT),
            ]
          : []),
        ...(recipe.byModel ? [t('byModel')] : []),
      ],
    };
  };

  async function sendText() {
    const text = recipeText(shared());
    setSaid(null);
    if (sheetOffered()) {
      try {
        await navigator.share({ title: recipe.title, text });
        return;
      } catch (error) {
        if (dismissed(error)) return;
        // A sheet that would not open: the text is copied instead.
      }
    }
    if (await copyText(text)) setSaid({ text: t('copied'), failed: false });
    else setByHand(text);
  }

  // The document's module, with @react-pdf, is fetched when one is asked for: the page never carries it.
  async function sendPdf() {
    setSaid(null);
    setMaking(true);
    try {
      const { recipePdf } = await import('./recipe-pdf');
      const document = await recipePdf(shared(), tCommon('appName'));
      const name = `${fileNameOf(recipe.title)}.pdf`;
      const file = new File([document], name, { type: 'application/pdf' });
      if (sheetOffered() && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ title: recipe.title, files: [file] });
          return;
        } catch (error) {
          if (dismissed(error)) return;
          // A sheet that would not take it, as one may long after the tap: the file is saved instead.
        }
      }
      saveFile(document, name);
    } catch (error) {
      console.error('[recipe pdf] generation failed', error);
      setSaid({ text: t('pdfFailed'), failed: true });
    } finally {
      setMaking(false);
    }
  }

  return (
    <div className="space-y-1">
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="text-sm text-muted-foreground">
          {t('label')}
        </span>
        {/* The two ways stay together: on a narrow screen they go under the words as one. */}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void sendText()}>
            <Share2 size={14} aria-hidden />
            <span className="ml-1">{t('text')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={making}
            onClick={() => void sendPdf()}
          >
            <FileDown size={14} aria-hidden />
            <span className="ml-1">{making ? t('making') : t('pdf')}</span>
          </Button>
        </div>
      </div>
      {/* Said where it happened, and read out: a text on the clipboard cannot be seen. */}
      <p
        role="status"
        className={
          said ? `text-sm ${said.failed ? 'text-destructive' : 'text-muted-foreground'}` : 'sr-only'
        }
      >
        {said?.text ?? ''}
      </p>
      <CopyByHand text={byHand} label={t('copyByHand')} onClose={() => setByHand(null)} />
    </div>
  );
}
