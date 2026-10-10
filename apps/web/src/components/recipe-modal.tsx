// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { PlannedIngredient, Recipe } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';

/**
 * Recipe detail in a modal. Lazy-loads the recipe by id when opened. Click on
 * the backdrop or the close button to dismiss; Escape also closes. It opens
 * with a scale-95→100 transition over 180 ms.
 */
export function RecipeModal({
  recipeId,
  amounts,
  onClose,
}: {
  recipeId: string | null;
  /** The ingredient lines of the planned meal the modal was opened from, so it
   *  shows what that meal takes, not the recipe's own servings. */
  amounts?: PlannedIngredient[];
  onClose: () => void;
}) {
  const t = useTranslations('recipeModal');
  const tDetail = useTranslations('recipeDetail');

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => api.get<Recipe>(`/recipes/${recipeId!}`),
    enabled: recipeId !== null,
    retry: false,
  });

  useEffect(() => {
    if (recipeId === null) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [recipeId, onClose]);

  return (
    <AnimatePresence>
      {recipeId !== null && (
        <motion.div
          key="recipe-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={t('title')}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-end gap-1 border-b border-border px-3 py-2">
              {recipe.data && (
                <Link href={`/recipes/${recipe.data.id}`} onClick={onClose}>
                  <Button type="button" variant="ghost" size="sm" title={t('openPage')}>
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    <span className="ml-1">{t('openPage')}</span>
                  </Button>
                </Link>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={t('close')}
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="p-6">
              {recipe.isLoading && <Skeleton className="h-64" />}
              {recipe.error && (
                <p className="text-sm text-muted-foreground">
                  {recipe.error instanceof ApiClientError && recipe.error.status === 404
                    ? tDetail('notFound')
                    : tDetail('loadFailed')}
                </p>
              )}
              {recipe.data && <RecipeView recipe={recipe.data} amounts={amounts} hideNutrition />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
