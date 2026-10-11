// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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

/**
 * A client that keeps its own tokens sends the refresh token here. A browser
 * sends nothing: its token is in a cookie the API set.
 */
export const RefreshRequest = z.object({
  refreshToken: z.string().min(1).optional(),
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
  /**
   * Absent for a browser that asked for a cookie session (the request header
   * `X-Session-Transport: cookie`): its refresh token is in an HttpOnly cookie
   * and never in an answer.
   */
  refreshToken: z.string().optional(),
  expiresIn: z.number(), // access-token TTL, seconds
  /** How long the refresh token is good for if it is not used, in seconds. */
  refreshExpiresIn: z.number(),
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

/** A session of an account, as the account sees it in the list of its sessions. */
export const AccountSession = z.object({
  /** The `sessionId` of the answers that belong to it. */
  id: z.string().uuid(),
  /** What it was opened from, as far as the request said ("Firefox · Linux"); null when it said nothing usable. */
  label: z.string().nullable(),
  startedAt: z.string().datetime(),
  /** When it last got a new access token. */
  lastUsedAt: z.string().datetime(),
  /** When it ends, however often it is used. Unused for long enough, it ends sooner. */
  endsAt: z.string().datetime(),
});
export type AccountSession = z.infer<typeof AccountSession>;

export const AuthResponse = z.object({
  user: AuthUser,
  tokens: AuthTokens,
  /** The session these tokens belong to: the same from sign-in to sign-out, through every refresh. */
  sessionId: z.string().uuid(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** What the administrator signs in with: the two values of the instance's environment. */
export const AdminSignInRequest = z
  .object({
    user: z.string().min(1).max(200),
    password: z.string().min(1).max(200),
  })
  .strict();
export type AdminSignInRequest = z.infer<typeof AdminSignInRequest>;

/** What the admin pages ask first: whether there is a panel at all, and whether this browser is signed in to it. */
export const AdminSessionState = z.object({
  enabled: z.boolean(),
  signedIn: z.boolean(),
});
export type AdminSessionState = z.infer<typeof AdminSessionState>;

