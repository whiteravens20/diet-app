import Link from 'next/link';
import { CalendarRange, ListChecks, Sparkles, Utensils } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const FEATURES = [
  { icon: Utensils, title: 'Deterministic nutrition', body: 'Every calorie and macro comes from a curated database — reproducible, never invented.' },
  { icon: CalendarRange, title: 'Smart meal plans', body: 'Multi-day plans that hit your calorie target and reuse ingredients to cut waste.' },
  { icon: ListChecks, title: 'Consolidated lists', body: 'Shopping lists merged, unit-normalised and grouped by aisle.' },
  { icon: Sparkles, title: 'BYOK AI — optional', body: 'Bring your own OpenAI, Anthropic, OpenRouter or Ollama key. Works fully without one.' },
];

/** Public landing page. */
export default function Landing() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-20">
      <section className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
          <Sparkles size={13} /> Self-hostable · Docker-first
        </span>
        <h1 className="mt-6 text-balance text-5xl font-semibold tracking-tight">
          Meal planning that actually adds up.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg text-muted-foreground">
          Calorie-targeted plans, deterministic nutrition and shopping lists that write
          themselves. AI optional — never required.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/register" className={buttonVariants({ size: 'lg' })}>
            Get started
          </Link>
          <Link href="/login" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
            Sign in
          </Link>
        </div>
      </section>

      <section className="mt-20 grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <Card key={f.title} className="p-6">
            <span className="inline-flex rounded-md bg-muted p-2 text-primary">
              <f.icon size={20} />
            </span>
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
          </Card>
        ))}
      </section>
    </main>
  );
}
