import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guards a route with the JWT access-token strategy. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
