// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { cn } from '@/lib/utils';

/** The drawings in `public/drawings`, each kept as two masks: `<name>-line.webp` and `<name>-fill.webp`. */
export type DrawingName =
  | 'shoot-a'
  | 'vegetables-a'
  | 'dish-plate'
  | 'dish-soup'
  | 'dish-salad'
  | 'dish-sandwich'
  | 'dish-porridge';

/**
 * A line drawing made by an image model in one style, kept as two masks, its line and the tint of what it holds,
 * and painted with the theme's own colours: light, dark and every palette follow without another picture. It fills
 * the box its `className` gives (positioned, sized): `contain` keeps the whole drawing inside it, `top` lays it the
 * width of the box from its top, so that a box flatter than the drawing shows only its upper part. Decorative: a
 * screen reader passes it by, and it holds no script.
 */
export function LineDrawing({
  name,
  className,
  fit = 'contain',
}: {
  name: DrawingName;
  className?: string;
  fit?: 'contain' | 'top';
}) {
  const fitted =
    fit === 'top'
      ? '[-webkit-mask-size:100%_auto] [mask-size:100%_auto] [-webkit-mask-position:top_left] [mask-position:top_left]'
      : '[-webkit-mask-size:contain] [mask-size:contain] [-webkit-mask-position:center] [mask-position:center]';
  const layer = (part: 'line' | 'fill') => {
    const url = `url(/drawings/${name}-${part}.webp)`;
    return { maskImage: url, WebkitMaskImage: url };
  };
  return (
    <div aria-hidden="true" className={cn('pointer-events-none', className)}>
      <div
        className={cn(
          'absolute inset-0 bg-primary/15 [-webkit-mask-repeat:no-repeat] [mask-repeat:no-repeat]',
          fitted,
        )}
        style={layer('fill')}
      />
      <div
        className={cn(
          'absolute inset-0 bg-primary/70 [-webkit-mask-repeat:no-repeat] [mask-repeat:no-repeat]',
          fitted,
        )}
        style={layer('line')}
      />
    </div>
  );
}
