// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/** Whether the instance offers products at all: it looks codes up, or it imports some country's. */
export const productsOffered = (config: ConfigService<Env, true>): boolean =>
  config.get('OPEN_FOOD_FACTS_LOOKUPS', { infer: true }) ||
  config.get('OPEN_FOOD_FACTS_COUNTRIES', { infer: true }).length > 0;
