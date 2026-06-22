import { z } from 'zod';

/** Optional Cloudflare Turnstile token — required only when Turnstile is enabled. */
const turnstileToken = z.string().optional();

/**
 * Password policy for new passwords (registration + reset). 12–128 characters
 * with mixed case and a digit. `LoginRequest` deliberately does NOT use this —
 * it must accept whatever an existing account was created with.
 */
export const newPassword = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[a-z]/, 'Password must contain a lowercase letter.')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter.')
  .regex(/[0-9]/, 'Password must contain a digit.');

/** Human-readable password rules, for display on registration / reset forms. */
export const PASSWORD_RULES = [
  'At least 12 characters',
  'An uppercase and a lowercase letter',
  'At least one digit',
] as const;

export const RegisterRequest = z.object({
  email: z.string().email(),
  password: newPassword,
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
  password: newPassword,
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** Confirms an email address from a verification link. */
export const VerifyEmailRequest = z.object({
  token: z.string().min(1),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;

/** Confirms a pending email change from the link sent to the new address. */
export const ConfirmEmailChangeRequest = z.object({
  token: z.string().min(1),
});
export type ConfirmEmailChangeRequest = z.infer<typeof ConfirmEmailChangeRequest>;

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
