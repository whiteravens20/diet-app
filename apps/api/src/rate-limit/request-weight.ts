// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { SetMetadata } from '@nestjs/common';

/** How many requests one request of a route counts as: what it costs the API, from what it asks. */
export type RequestWeight = (req: Record<string, unknown>) => number;

export const REQUEST_WEIGHT = 'rate-limit:request-weight';

/**
 * Marks a route whose request may be the work of several: it is counted as
 * many times against its sender's allowance, and refused when they do not all
 * fit. A request that asks for two plans uses up two makings of a plan.
 */
export const CountsAs = (weight: RequestWeight): MethodDecorator =>
  SetMetadata(REQUEST_WEIGHT, weight);
