import { z } from 'zod';

/** Optional Cloudflare Turnstile token — required only when Turnstile is enabled. */
const turnstileToken = z.string().optional();

export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(128),
  displayName: z.string().min(1).max(80),
  turnstileToken,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  turnstileToken,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PasswordResetRequest = z.object({
  email: z.string().email(),
  turnstileToken,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

export const PasswordResetConfirm = z.object({
  token: z.string().min(1),
  password: z.string().min(10).max(128),
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** Token pair returned by login / register / refresh. */
export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(), // access-token TTL, seconds
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const AuthUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: z.enum(['user', 'admin']),
  emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUser>;

export const AuthResponse = z.object({
  user: AuthUser,
  tokens: AuthTokens,
});
export type AuthResponse = z.infer<typeof AuthResponse>;
