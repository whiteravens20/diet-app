/**
 * Per-locale status derivation — single source of truth for the curation
 * queue. Used by the admin draft controller (BasicAuth) and the reviewer
 * controller (Phase H, cookie auth).
 *
 *   APPROVED  ↔ every expected locale has an APPROVE row.
 *   REJECTED  ↔ at least one expected locale has a REJECT row.
 *   PENDING   ↔ otherwise.
 *   SHIPPED   ↔ owned by the ship runner (Phase E); never derived here.
 */
export function deriveDraftStatus(
  expectedLocales: string[],
  reviews: { locale: string; action: string }[],
): 'PENDING' | 'APPROVED' | 'REJECTED' {
  if (reviews.some((r) => r.action === 'REJECT')) return 'REJECTED';
  const approved = new Set(
    reviews.filter((r) => r.action === 'APPROVE').map((r) => r.locale),
  );
  if (expectedLocales.every((l) => approved.has(l))) return 'APPROVED';
  return 'PENDING';
}
