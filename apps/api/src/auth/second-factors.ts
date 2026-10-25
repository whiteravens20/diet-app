// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { SecondFactorSetup, SecondFactorState } from '@diet-app/shared';
import { decrypt, deriveKey, encrypt } from '../common/crypto.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { base32, matchingStep, otpauthUri, SECRET_BYTES } from '../common/totp.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Whose second factor it is: an account's, or the administrator's, who has no account. */
export type FactorOwner = { userId: string } | 'administrator';

/** The id of the administrator's second factor: there is one at most. */
const ADMINISTRATOR = 'administrator';

/** How long a secret that was handed out may wait for its first code. */
const SETUP_SECONDS = 15 * 60;
const RECOVERY_CODES = 10;
/** The wrong code in a row after which the next has to wait. */
const CODES_BEFORE_WAIT = 5;
/** The first wait. Every further wrong code doubles it, up to the longest. */
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 24 * 60 * 60_000;

/** What came of looking at a code. */
export type CodeCheck =
  | { accepted: true; by: 'app' | 'recovery-code' }
  /** `nowWaits`: this was the wrong code after which codes from the app have to wait. */
  | { accepted: false; nowWaits: boolean };

/** Letters and digits that are not taken for one another when read or typed (Crockford's base 32). */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_LENGTH = 10;

const withoutGaps = (code: string): string => code.replace(/[\s-]/g, '');

/** A recovery code as it is compared: however it was typed, with the letters that look like digits read as those digits. */
const asTyped = (code: string): string =>
  withoutGaps(code).toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1');

/** A recovery code as it is shown: in two halves, which is easier to copy by hand. */
const asShown = (code: string): string =>
  `${code.slice(0, RECOVERY_LENGTH / 2)}-${code.slice(RECOVERY_LENGTH / 2)}`;

function newRecoveryCode(): string {
  // Thirty-two symbols: five bits of every byte, and none more likely than another.
  return Array.from(randomBytes(RECOVERY_LENGTH), (byte) => RECOVERY_ALPHABET[byte & 31]).join('');
}

const whereOf = (owner: FactorOwner): { id: string } | { userId: string } =>
  owner === ADMINISTRATOR ? { id: ADMINISTRATOR } : { userId: owner.userId };
const nameOf = (owner: FactorOwner): string =>
  owner === ADMINISTRATOR ? ADMINISTRATOR : owner.userId;

/**
 * The second step of signing in: a code that an authenticator app makes from
 * a secret and the time, for an account that has set one up, and for the
 * administrator.
 *
 * The secret is kept encrypted for whose it is. A code is good once, and for
 * about a minute around the moment it is shown. A code has a million values,
 * so guessing is what has to be made slow: after the fifth wrong code in a
 * row the next is not looked at for half a minute, then twice as long after
 * each further one, up to a day. Codes for one factor are looked at one after
 * another, so that sending many at once is no way around the count. The
 * count is kept with the factor: it holds across every address a guess comes
 * from, every process of the API, and a restart.
 *
 * An account also gets ten recovery codes, each good once in the place of a
 * code from the app. They are long enough that guessing them is no use, so a
 * recovery code is looked at even while codes from the app have to wait:
 * whoever keeps guessing cannot keep the holder of the account out.
 */
@Injectable()
export class SecondFactors {
  private readonly logger = new Logger('SecondFactor');
  private readonly key: string;
  private readonly recoveryKey: string;
  private readonly host: string;

  /** The clock, replaceable in a test. */
  now: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    const master = config.get('DATA_ENCRYPTION_SECRET', { infer: true });
    this.key = deriveKey(master, 'second-factor');
    this.recoveryKey = deriveKey(master, 'recovery-codes');
    // Without a port: the label of a code is no place for a colon, and the name says enough.
    this.host = new URL(config.get('APP_URL', { infer: true })).hostname;
  }

  async has(owner: FactorOwner): Promise<boolean> {
    return (
      (await this.prisma.secondFactor.findUnique({
        where: whereOf(owner),
        select: { id: true },
      })) !== null
    );
  }

  async stateOf(userId: string): Promise<SecondFactorState> {
    const factor = await this.prisma.secondFactor.findUnique({
      where: { userId },
      select: {
        createdAt: true,
        _count: { select: { recoveryCodes: { where: { usedAt: null } } } },
      },
    });
    return {
      enabled: factor !== null,
      since: factor?.createdAt.toISOString() ?? null,
      recoveryCodesLeft: factor?._count.recoveryCodes ?? 0,
    };
  }

  /**
   * A new secret for an authenticator app, with what the app scans to take
   * it over. `account` is what the app shows next to the codes. Nothing is
   * kept of it: the secret goes out sealed as well (`enrolment`), and comes
   * back with the first code. Until then it counts for nothing, and one that
   * never comes back leaves nothing behind.
   */
  propose(owner: FactorOwner, account: string): SecondFactorSetup {
    const secret = randomBytes(SECRET_BYTES);
    const pending = JSON.stringify({
      secret: secret.toString('hex'),
      expiresAt: this.now() + SETUP_SECONDS * 1000,
    });
    return {
      secret: base32(secret),
      uri: otpauthUri({
        secret,
        issuer: `Diet App${owner === ADMINISTRATOR ? ' admin' : ''} (${this.host})`,
        account,
      }),
      enrolment: encrypt(pending, this.key, `second-factor-setup:${nameOf(owner)}`),
      expiresIn: SETUP_SECONDS,
    };
  }

  /**
   * Put a proposed secret to use: `code` shows that the app has it. From
   * then on the owner has a second factor. `also` is done with it or not at
   * all. Returns the recovery codes of an account, which nobody can be shown
   * a second time.
   */
  async begin(
    owner: FactorOwner,
    enrolment: string,
    code: string,
    also?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<string[]> {
    const secret = this.proposed(owner, enrolment);
    const step = matchingStep(secret, withoutGaps(code), this.now());
    if (step === null) throw wrongCode();

    const id = owner === ADMINISTRATOR ? ADMINISTRATOR : randomUUID();
    const recoveryCodes =
      owner === ADMINISTRATOR ? [] : Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await this.prisma
      .$transaction(async (tx) => {
        await tx.secondFactor.create({
          data: {
            id,
            userId: owner === ADMINISTRATOR ? null : owner.userId,
            secretEncrypted: encrypt(
              secret.toString('hex'),
              this.key,
              `second-factor:${nameOf(owner)}`,
            ),
            // The code that set the factor up is used, like any that is accepted.
            lastStep: step,
            recoveryCodes: {
              create: recoveryCodes.map((recoveryCode) => ({
                codeHash: this.recoveryHash(id, recoveryCode),
              })),
            },
          },
        });
        await also?.(tx);
      })
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? alreadyOn() : error;
      });
    return recoveryCodes.map(asShown);
  }

  /**
   * Look at a code for the second factor of `owner`: six digits from the
   * app, or for an account a recovery code. Null when the owner has no second
   * factor. Throws while codes from the app have to wait.
   */
  async check(owner: FactorOwner, given: string): Promise<CodeCheck | null> {
    const code = withoutGaps(given);
    const fromApp = /^[0-9]{6}$/.test(code);

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<CodeCheck | { waitSeconds: number } | null> => {
        const factor = await tx.secondFactor.findUnique({ where: whereOf(owner) });
        if (!factor) return null;
        if (!fromApp) {
          // Too long to guess: not counted, and not kept waiting.
          if (factor.userId === null) return { accepted: false, nowWaits: false };
          const used = await tx.recoveryCode.updateMany({
            where: {
              secondFactorId: factor.id,
              codeHash: this.recoveryHash(factor.id, asTyped(given)),
              usedAt: null,
            },
            data: { usedAt: new Date(this.now()) },
          });
          if (used.count !== 1) return { accepted: false, nowWaits: false };
          await tx.secondFactor.update({
            where: { id: factor.id },
            data: { failures: 0, blockedUntil: null },
          });
          return { accepted: true, by: 'recovery-code' };
        }

        // One code at a time for one factor: the next waits here until this one
        // has been counted, and then sees the count it left.
        await tx.$queryRaw`SELECT 1 FROM "SecondFactor" WHERE "id" = ${factor.id} FOR UPDATE`;
        const locked = await tx.secondFactor.findUnique({ where: { id: factor.id } });
        if (!locked) return null;
        const now = this.now();
        const waitMs = (locked.blockedUntil?.getTime() ?? 0) - now;
        // While the factor waits, a right guess is worth as little as a wrong one.
        if (waitMs > 0) return { waitSeconds: Math.ceil(waitMs / 1000) };

        const secret = Buffer.from(
          decrypt(locked.secretEncrypted, this.key, `second-factor:${nameOf(owner)}`),
          'hex',
        );
        const step = matchingStep(secret, code, now);
        // A code that was accepted once is not accepted again, nor is one from before it.
        if (step !== null && step > locked.lastStep) {
          await tx.secondFactor.update({
            where: { id: locked.id },
            data: { lastStep: step, failures: 0, blockedUntil: null },
          });
          return { accepted: true, by: 'app' };
        }
        const failures = locked.failures + 1;
        const beyond = failures - CODES_BEFORE_WAIT;
        const blockedUntil =
          beyond >= 0
            ? new Date(now + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** beyond))
            : null;
        await tx.secondFactor.update({
          where: { id: locked.id },
          data: { failures, blockedUntil },
        });
        const next = blockedUntil
          ? `; the next code in ${Math.ceil((blockedUntil.getTime() - now) / 1000)} s`
          : '';
        this.logger.warn(
          `wrong code for the second factor of ${nameOf(owner)} (${failures} in a row${next})`,
        );
        return { accepted: false, nowWaits: failures === CODES_BEFORE_WAIT };
      },
    );

    if (outcome === null) return null;
    if ('waitSeconds' in outcome) throw mustWait(outcome.waitSeconds);
    return outcome;
  }

  /** Take the second factor away, with its recovery codes. False when there was none. */
  async remove(owner: FactorOwner): Promise<boolean> {
    return (await this.prisma.secondFactor.deleteMany({ where: whereOf(owner) })).count > 0;
  }

  /** New recovery codes for an account in the place of the ones it had, used or not. Null when it has no second factor. */
  async replaceRecoveryCodes(userId: string): Promise<string[] | null> {
    const factor = await this.prisma.secondFactor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!factor) return null;
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { secondFactorId: factor.id } }),
      this.prisma.recoveryCode.createMany({
        data: recoveryCodes.map((code) => ({
          secondFactorId: factor.id,
          codeHash: this.recoveryHash(factor.id, code),
        })),
      }),
    ]);
    return recoveryCodes.map(asShown);
  }

  /** How many recovery codes an account has left. */
  recoveryCodesLeft(userId: string): Promise<number> {
    return this.prisma.recoveryCode.count({ where: { secondFactor: { userId }, usedAt: null } });
  }

  /** The secret of a proposal that was made here, for this owner, not too long ago. */
  private proposed(owner: FactorOwner, enrolment: string): Buffer {
    let pending: { secret?: unknown; expiresAt?: unknown };
    try {
      pending = JSON.parse(
        decrypt(enrolment, this.key, `second-factor-setup:${nameOf(owner)}`),
      ) as typeof pending;
    } catch {
      throw setupExpired();
    }
    if (
      typeof pending.secret !== 'string' ||
      typeof pending.expiresAt !== 'number' ||
      pending.expiresAt < this.now()
    )
      throw setupExpired();
    return Buffer.from(pending.secret, 'hex');
  }

  /** What is kept of a recovery code: a keyed hash, bound to the factor the code belongs to. */
  private recoveryHash(factorId: string, code: string): string {
    return createHmac('sha256', Buffer.from(this.recoveryKey, 'hex'))
      .update(`${factorId}:${code}`)
      .digest('hex');
  }
}

export const wrongCode = (): HttpException =>
  new HttpException(
    {
      error: 'INVALID_SECOND_FACTOR_CODE',
      message: 'That code is not right. Codes change every half a minute, and each works once.',
    },
    HttpStatus.UNAUTHORIZED,
  );

export const alreadyOn = (): ConflictException =>
  new ConflictException({
    error: 'SECOND_FACTOR_ALREADY_ON',
    message: 'A second factor is set up already. Switch it off before setting up another.',
  });

export const notOn = (): ConflictException =>
  new ConflictException({ error: 'SECOND_FACTOR_NOT_ON', message: 'No second factor is set up.' });

const setupExpired = (): BadRequestException =>
  new BadRequestException({
    error: 'SECOND_FACTOR_SETUP_EXPIRED',
    message: 'This set-up has run out or is not one that was begun here. Begin again.',
  });

const mustWait = (seconds: number): HttpException =>
  new HttpException(
    {
      error: 'TOO_MANY_ATTEMPTS',
      message: `Too many wrong codes. Try again in ${seconds} seconds.`,
      retryAfterSeconds: seconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
