// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import Image from 'next/image';
import type { ReactNode } from 'react';

/**
 * Page header banner: the page title beside a curated food photo. The words
 * stand on the theme `background` colour and never on the photo, so they keep
 * their contrast in light and dark, in every palette and at every width,
 * whatever the photo shows. On a narrow screen the photo is a strip over the
 * words; from the `sm` width on it fills the banner beside them. Either way it
 * fades into the side the words are on. The photo is decorative (`alt=""`):
 * the heading carries the meaning.
 *
 * Optional `children` render under the subtitle (e.g. a page-level action
 * button).
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
    <div className="overflow-hidden rounded-xl border border-border bg-background sm:grid sm:grid-cols-[min(60%,36rem)_1fr]">
      <div className="relative h-24 sm:order-last sm:h-auto">
        <Image
          src={image}
          alt=""
          fill
          priority
          sizes="(min-width: 40rem) 60vw, 100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent to-70% sm:bg-gradient-to-r sm:to-40%" />
      </div>
      <div className="px-6 pb-8 pt-3 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}
