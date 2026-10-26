// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { SetMetadata } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/** Where a route keeps what it answers with. */
export const ANSWERS = 'contract:answers';

/**
 * What a route answers with when it does what it was asked: a schema of the
 * shared contract. The published contract (`docs/api/`) is written from it,
 * and the integration tests hold every answer of the route to it. A route
 * without it answers with no body.
 */
export const Answers = (schema: ZodType): MethodDecorator => SetMetadata(ANSWERS, schema);

/** The same for a route that answers with a list of them. */
export const AnswersListOf = (schema: ZodType): MethodDecorator =>
  SetMetadata(ANSWERS, z.array(schema));

/** Where a route keeps that it answers with a file, and of which kind. */
export const ANSWERS_WITH_A_FILE = 'contract:answers-with-a-file';

/** A route that answers with a file to save: the media type of the file. */
export const AnswersWithAFile = (mediaType: string): MethodDecorator =>
  SetMetadata(ANSWERS_WITH_A_FILE, mediaType);
