import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Placeholder for screens that are scaffolded but not yet built out. Each lists
 * the API endpoints the screen will consume — see docs/product/roadmap.md.
 */
export function PagePlaceholder({
  title,
  icon: Icon,
  description,
  endpoints,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
  endpoints: string[];
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      <Card className="max-w-lg">
        <CardContent className="pt-5">
          <span className="inline-flex rounded-md bg-muted p-2 text-primary">
            <Icon size={20} />
          </span>
          <p className="mt-3 text-sm text-muted-foreground">
            This screen is scaffolded. It will consume:
          </p>
          <ul className="mt-2 space-y-1">
            {endpoints.map((e) => (
              <li key={e} className="font-mono text-xs text-muted-foreground">
                {e}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
