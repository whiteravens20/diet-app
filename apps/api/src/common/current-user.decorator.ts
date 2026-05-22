import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

/** The authenticated principal attached to the request by JwtStrategy. */
export interface RequestUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

/** Injects the authenticated user: `@CurrentUser() user: RequestUser`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const request = ctx.switchToHttp().getRequest<{ user: RequestUser }>();
    return request.user;
  },
);
