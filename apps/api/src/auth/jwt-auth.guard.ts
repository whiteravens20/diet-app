// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guards a route with the JWT access-token strategy. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
