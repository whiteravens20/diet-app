import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * F19 — shared empty-state surface: large icon, headline, supporting copy,
 * and a single primary CTA. Lives inside a Card so it inherits the same
 * border/background treatment as content rows. Caller passes whichever
 * Lucide icon makes contextual sense.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  cta,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  cta?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('mx-auto max-w-xl', className)}>
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon size={28} strokeWidth={1.75} aria-hidden />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        {cta && <div className="pt-1">{cta}</div>}
      </CardContent>
    </Card>
  );
}
