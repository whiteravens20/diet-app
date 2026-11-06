// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { AdminPanel } from './admin-panel';
import { DOT } from '@/lib/figure-line';

export const metadata = { title: `Admin${DOT}Diet App` };

export default function AdminPage() {
  return <AdminPanel />;
}
