// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ReactNode } from 'react';

/**
 * A page of the app as it takes the place of another. A template is made anew
 * on every move between pages, where the layout around it stays: so the page
 * fades in and the navigation beside it does not. Nothing fades for somebody
 * who asked their system for less motion (`.page-in` in `globals.css`).
 *
 * The fade is of opacity alone. A page that moved while it came in would take
 * what it holds in a fixed place along with it.
 */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="page-in">{children}</div>;
}
