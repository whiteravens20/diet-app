// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { LOCALES, type Locale } from '@diet-app/shared';

/**
 * A language a request names, as the list of languages holds it. Such a language goes on to name the fields of
 * objects (a draft's titles, descriptions and steps by language) and a file of examples, so the value used is the
 * list's own: no other string reaches them, whatever let it through before. The request's validation has refused
 * any other already; one that came past it anyway is refused here alike.
 */
export function listedLocale<L extends Locale>(locale: L): L {
  const listed = LOCALES.find((one) => one === locale);
  if (listed === undefined)
    throw new BadRequestException({
      statusCode: 400,
      error: 'VALIDATION_FAILED',
      message: 'Request payload failed validation.',
    });
  return listed as L;
}
