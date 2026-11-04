// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ReactNode } from 'react';

/** Open Food Facts, where anybody can add or correct a product for everybody. */
export const OPEN_FOOD_FACTS = 'https://world.openfoodfacts.org';
/** The licence its data come under. */
export const ODBL = 'https://opendatacommons.org/licenses/odbl/1-0/';

/** The page of a product at Open Food Facts, where it is corrected. */
export const offProductPage = (code: string): string =>
  `${OPEN_FOOD_FACTS}/product/${encodeURIComponent(code)}`;

/** A part of a text that leads to `href` in a new tab, for `t.rich`. */
export function linkTo(href: string) {
  return function Linked(chunks: ReactNode) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {chunks}
      </a>
    );
  };
}
