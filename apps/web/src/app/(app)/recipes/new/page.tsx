// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { EMPTY_RECIPE, OwnRecipeForm } from '@/components/own-recipe-form';

/** A recipe of one's own, written by hand. */
export default function NewOwnRecipePage() {
  const t = useTranslations('ownRecipe');
  const tDetail = useTranslations('recipeDetail');
  return (
    <div className="space-y-4">
      <Link href="/recipes" className="text-sm text-primary underline underline-offset-2">
        ← {tDetail('back')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('newTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('newIntro')}</p>
      <OwnRecipeForm initial={EMPTY_RECIPE} />
    </div>
  );
}
