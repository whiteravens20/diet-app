import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import Image from 'next/image';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * F19 — shared empty-state surface: a headline, supporting copy, and a single
 * primary CTA. Lives inside a Card so it inherits the same border/background
 * treatment as content rows.
 *
 * F19.1 (b): pass `image` (a path under /imagery) to show real food photography
 * instead of the Lucide glyph; `icon` stays the fallback, so callers that don't
 * set an image are unchanged.
 */
export function EmptyState({
  icon: Icon,
  image,
  title,
  description,
  cta,
  className,
}: {
  icon: LucideIcon;
  image?: string;
  title: string;
  description: string;
  cta?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('mx-auto max-w-xl overflow-hidden', className)}>
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        {image ? (
          <div className="relative h-40 w-full max-w-xs overflow-hidden rounded-lg">
            <Image src={image} alt="" fill sizes="320px" className="object-cover" />
          </div>
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon size={28} strokeWidth={1.75} aria-hidden />
          </span>
        )}
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        {cta && <div className="pt-1">{cta}</div>}
      </CardContent>
    </Card>
  );
}
