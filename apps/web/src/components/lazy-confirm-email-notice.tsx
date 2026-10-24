// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import dynamic from 'next/dynamic';

/**
 * The notice of an address that is not confirmed, fetched once the page is
 * drawn: it is for an account whose address waits, on an instance that sends
 * mail, and no first visit of anybody else waits for it.
 */
export const LazyConfirmEmailNotice = dynamic(() => import('./confirm-email-notice').then((notice) => notice.ConfirmEmailNotice), { ssr: false });
