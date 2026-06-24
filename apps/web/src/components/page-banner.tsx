import Image from 'next/image';
import type { ReactNode } from 'react';

/**
 * F19.1 — page header banner: a curated food photo behind the page title with a
 * left-to-right scrim in the theme `background` colour, so the heading stays
 * legible and the whole surface still reads correctly in light/dark and every
 * palette. The photo is decorative (`alt=""`) — the heading carries meaning.
 *
 * Height is driven by the text block; the image fills behind it (`-z-10`, with
 * `isolate` keeping the stacking context local). Optional `children` render
 * under the subtitle (e.g. a page-level action button).
 */
export function PageBanner({
  image,
  title,
  subtitle,
  children,
}: {
  image: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative isolate overflow-hidden rounded-xl border border-border">
      <Image src={image} alt="" fill priority sizes="100vw" className="-z-10 object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-background via-background/85 to-transparent" />
      <div className="max-w-xl px-6 py-10 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}
