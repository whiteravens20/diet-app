// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';

/** Optional Cloudflare Turnstile token — required only when Turnstile is enabled. */
const turnstileToken = z.string().max(2048).optional();

/** An e-mail address. No longer than an address can be. */
export const emailAddress = z.string().email().max(254);

/** A token from a link in a mail, or one that a session is refreshed with. */
const token = z.string().min(1).max(512);

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
  email: emailAddress,
  password: newPassword,
  displayName: z.string().min(1).max(80),
  turnstileToken,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: emailAddress,
  password: z.string().min(1).max(128),
  turnstileToken,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PasswordResetRequest = z.object({
  email: emailAddress,
  turnstileToken,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

export const PasswordResetConfirm = z.object({
  token,
  password: newPassword,
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

/**
 * A client that keeps its own tokens sends the refresh token here. A browser
 * sends nothing: its token is in a cookie the API set.
 */
export const RefreshRequest = z.object({
  refreshToken: token.optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** Confirms an email address from a verification link. */
export const VerifyEmailRequest = z.object({
  token,
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;

/** Confirms a pending email change from the link sent to the new address. */
export const ConfirmEmailChangeRequest = z.object({
  token,
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

/** The most sessions the list of an account's sessions holds: the ones used last. */
export const MAX_SESSIONS_LISTED = 50;

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

/**
 * A code of the second step of signing in: the six digits an authenticator
 * app shows, or, where the account has them, a recovery code in their place.
 * Spaces and dashes in it do not count.
 */
const secondFactorCode = z.string().trim().min(6).max(40);

/** The six digits an authenticator app shows, and nothing in their place. */
const appCode = z.string().trim().min(6).max(12);

/**
 * What signing in answers for an account with a second factor: the password
 * was right, and the second step is still to come.
 */
export const SecondFactorChallenge = z.object({
  secondFactor: z.object({
    /** Goes back with the code. Good for one sign-in, and for `expiresIn` seconds. */
    challenge: z.string(),
    expiresIn: z.number(),
  }),
});
export type SecondFactorChallenge = z.infer<typeof SecondFactorChallenge>;

/** What `POST /auth/login` answers: a session, or the challenge of the second step. */
export const LoginResponse = z.union([AuthResponse, SecondFactorChallenge]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/**
 * A client that keeps its own tokens asks for a code that signs a browser in
 * to its account (`POST /auth/browser-code`). It shows its refresh token,
 * which is used up as a refresh uses it.
 */
export const BrowserCodeRequest = z.object({
  refreshToken: token,
});
export type BrowserCodeRequest = z.infer<typeof BrowserCodeRequest>;

/**
 * The next pair of the session that asked, as a refresh gives it, and the
 * code: good for `codeExpiresIn` seconds and once. The client hands the code
 * to the web application's page `/from-the-app` in the address's fragment.
 */
export const BrowserCode = AuthResponse.extend({
  code: z.string(),
  codeExpiresIn: z.number().int(),
});
export type BrowserCode = z.infer<typeof BrowserCode>;

/**
 * The web application's page asks whose a code is (`POST /auth/browser-sign-in/account`)
 * and, once its reader has said that it is theirs, signs its browser in with it
 * (`POST /auth/browser-sign-in`).
 */
export const BrowserSignInRequest = z.object({
  code: token,
});
export type BrowserSignInRequest = z.infer<typeof BrowserSignInRequest>;

/** The account a code would sign a browser in to, for its reader to recognise before the code is used. */
export const BrowserCodeAccount = z.object({
  email: z.string(),
  displayName: z.string(),
});
export type BrowserCodeAccount = z.infer<typeof BrowserCodeAccount>;

/** The second step of signing in: the challenge of the first, and a code. */
export const SecondFactorSignInRequest = z.object({
  challenge: z.string().min(1).max(200),
  code: secondFactorCode,
});
export type SecondFactorSignInRequest = z.infer<typeof SecondFactorSignInRequest>;

/** Whether an account signs in with a second factor, and how many recovery codes it has left. */
export const SecondFactorState = z.object({
  enabled: z.boolean(),
  since: z.string().datetime().nullable(),
  recoveryCodesLeft: z.number().int(),
});
export type SecondFactorState = z.infer<typeof SecondFactorState>;

/** Asks for a secret to set an authenticator app up with. */
export const SecondFactorSetupRequest = z.object({
  currentPassword: z.string().min(1).max(128),
});
export type SecondFactorSetupRequest = z.infer<typeof SecondFactorSetupRequest>;

/** A secret for an authenticator app. It counts for nothing until a code made from it has come back. */
export const SecondFactorSetup = z.object({
  /** For typing into the app, where a camera is no help. */
  secret: z.string(),
  /** For the QR code the app scans. */
  uri: z.string(),
  /** Goes back with the first code, within `expiresIn` seconds. */
  enrolment: z.string(),
  expiresIn: z.number(),
});
export type SecondFactorSetup = z.infer<typeof SecondFactorSetup>;

/** The first code of an authenticator app that was just set up: from then on signing in takes one. */
export const SecondFactorConfirmRequest = z.object({
  enrolment: z.string().min(1).max(2000),
  code: appCode,
});
export type SecondFactorConfirmRequest = z.infer<typeof SecondFactorConfirmRequest>;

/** The recovery codes of an account. Shown this once: what they are is not kept. */
export const RecoveryCodes = z.object({
  recoveryCodes: z.array(z.string()),
});
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

/**
 * For what only the holder of an account and of its second factor may do:
 * switch the factor off, or replace the recovery codes.
 */
export const SecondFactorProofRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  code: secondFactorCode,
});
export type SecondFactorProofRequest = z.infer<typeof SecondFactorProofRequest>;

/**
 * What the administrator signs in with: the two values of the instance's
 * environment, and a code where the administrator has a second factor.
 */
export const AdminSignInRequest = z
  .object({
    user: z.string().min(1).max(200),
    password: z.string().min(1).max(200),
    code: appCode.optional(),
  })
  .strict();
export type AdminSignInRequest = z.infer<typeof AdminSignInRequest>;

/**
 * What the admin pages ask first: whether there is a panel at all, whether
 * this browser is signed in to it, and whether signing in takes a code.
 */
export const AdminSessionState = z.object({
  enabled: z.boolean(),
  signedIn: z.boolean(),
  secondFactor: z.boolean(),
});
export type AdminSessionState = z.infer<typeof AdminSessionState>;

/** The administrator asks for a secret to set an authenticator app up with. */
export const AdminSecondFactorSetupRequest = z.object({ password: z.string().min(1).max(200) }).strict();
export type AdminSecondFactorSetupRequest = z.infer<typeof AdminSecondFactorSetupRequest>;

/** The administrator switches the second factor off. */
export const AdminSecondFactorOffRequest = z
  .object({
    password: z.string().min(1).max(200),
    code: appCode,
  })
  .strict();
export type AdminSecondFactorOffRequest = z.infer<typeof AdminSecondFactorOffRequest>;

/** The administrator takes the second factor off an account whose holder lost it. */
export const AccountSecondFactorRemoval = z.object({ email: emailAddress }).strict();
export type AccountSecondFactorRemoval = z.infer<typeof AccountSecondFactorRemoval>;

