// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ReactNode } from 'react';
import { AccountPreferences } from '@/components/account-preferences';
import { LazyConfirmEmailNotice } from '@/components/lazy-confirm-email-notice';
import { NotificationToast } from '@/components/notification-toast';
import { SessionGate } from '@/components/session-gate';
import { Sidebar } from '@/components/sidebar';

/**
 * The shell of a signed-in account: its navigation, and the page. Beside each
 * other on a wide screen; on a narrow one the navigation is a bar over the
 * page. The page waits for the session (see `SessionGate`), and then takes on
 * the account's language, theme and palette. An address that is not
 * confirmed, and a notification that comes in, are said over whichever page
 * is open.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-10">
        <SessionGate>
          <AccountPreferences />
          <LazyConfirmEmailNotice />
          {children}
        </SessionGate>
      </main>
      <NotificationToast />
    </div>
  );
}
