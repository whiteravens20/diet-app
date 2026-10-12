// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Put a text on the clipboard. True when it is there. A browser gives a page
 * its clipboard only over https (or on the machine itself), and only when it
 * may: an instance at home over plain http has none, and whoever calls this
 * shows the text to be copied by hand instead.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
