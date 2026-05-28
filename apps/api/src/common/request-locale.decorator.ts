import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Locale, type Locale as LocaleType } from '@diet-app/shared';

/**
 * Resolves the request locale for translation-aware endpoints.
 *
 * Order of precedence:
 *   1. `Accept-Language` header (the web client sets this from `useLocale()`
 *      on every request; the Android client will do the same).
 *   2. Fallback to `en` (the canonical locale; every translatable surface
 *      always has an `en` value to fall back to).
 *
 * We deliberately do NOT consult the DB-stored `user.locale` here. That would
 * cost a round-trip on every request and the web client already carries the
 * authoritative session locale in its provider. The DB column is the source
 * of truth across devices; the header is the source of truth for *this*
 * request.
 *
 * Usage: `searchRecipes(@RequestLocale() locale: Locale) { … }`
 */
export const RequestLocale = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): LocaleType => {
    const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const header = request.headers['accept-language'];
    return resolveLocale(header);
  },
);

/** Pure helper for tests + non-controller call sites. */
export function resolveLocale(acceptLanguage: string | undefined): LocaleType {
  if (!acceptLanguage) return 'en';
  // Accept-Language can be `pl,en;q=0.9` or just `pl-PL`; take the first
  // 2-letter prefix and match against the supported enum. Quality values
  // and weighting are ignored — we don't yet support fine-grained
  // negotiation and the web client only ever sends a single tag.
  const first = acceptLanguage.split(',')[0]?.trim().slice(0, 2).toLowerCase();
  if (first && (Locale.options as readonly string[]).includes(first)) {
    return Locale.parse(first);
  }
  return 'en';
}
