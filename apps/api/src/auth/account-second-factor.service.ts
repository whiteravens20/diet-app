// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Locale, type RecoveryCodes, type SecondFactorChallenge, type SecondFactorConfirmRequest, type SecondFactorProofRequest, type SecondFactorSetup, type SecondFactorSetupRequest, type SecondFactorSignInRequest, type SecondFactorState } from '@diet-app/shared';
import { Passwords } from '../common/passwords.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountEmail } from './account-email.js';
import { alreadyOn, notOn, SecondFactors, wrongCode } from './second-factors.js';

/** How long an account has for its code once its password was right. */
const CHALLENGE_SECONDS = 5 * 60;

/** As much of an account as its second factor needs. */
interface Holder {
  id: string;
  emailEncrypted: string;
  locale: string;
}

const noSuchChallenge = (): UnauthorizedException =>
  new UnauthorizedException({ error: 'INVALID_SIGN_IN_CHALLENGE', message: 'This sign-in took too long or was finished already. Sign in with your password again.' });

/**
 * The second factor of an account: setting it up, signing in with it, and
 * taking it away again.
 *
 * Setting one up and taking it away are for the holder of the account, who
 * shows the password again; taking it away takes a code as well. A password
 * that was reset by mail leaves the factor where it is: whoever reads the
 * mailbox does not hold the app. The holder who lost the app and the recovery
 * codes turns to the operator of the instance.
 */
@Injectable()
export class AccountSecondFactor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly factors: SecondFactors,
    private readonly passwords: Passwords,
    private readonly emails: AccountEmail,
    private readonly mail: MailService,
  ) {}

  state(userId: string): Promise<SecondFactorState> {
    return this.factors.stateOf(userId);
  }

  isOn(userId: string): Promise<boolean> {
    return this.factors.has({ userId });
  }

  /** A secret to set an authenticator app up with. */
  async propose(userId: string, dto: SecondFactorSetupRequest): Promise<SecondFactorSetup> {
    const holder = await this.holderOf(userId, dto.currentPassword);
    if (await this.isOn(userId)) throw alreadyOn();
    return this.factors.propose({ userId }, this.addressOf(holder));
  }

  /**
   * The first code from the app: from now on signing in takes one. The
   * session that set it up has shown the code and goes on; every other
   * session of the account ends, because it began with a password alone.
   */
  async begin(userId: string, sessionId: string, dto: SecondFactorConfirmRequest): Promise<RecoveryCodes> {
    const now = new Date();
    const recoveryCodes = await this.factors.begin({ userId }, dto.enrolment, dto.code, async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId, familyId: sessionId }, data: { secondFactorAt: now } });
      await tx.refreshToken.updateMany({ where: { userId, familyId: { not: sessionId }, revokedAt: null }, data: { revokedAt: now } });
    });
    const holder = await this.prisma.user.findUnique({ where: { id: userId } });
    if (holder) this.mail.sendSecondFactorOnNotice(this.addressOf(holder), Locale.parse(holder.locale));
    return { recoveryCodes };
  }

  /** Switch the second factor off: signing in takes the password alone again. */
  async end(userId: string, dto: SecondFactorProofRequest): Promise<void> {
    const holder = await this.holderOf(userId, dto.currentPassword);
    await this.prove(holder, dto.code, notOn);
    await this.factors.remove({ userId });
    this.mail.sendSecondFactorOffNotice(this.addressOf(holder), 'holder', Locale.parse(holder.locale));
  }

  /** New recovery codes in the place of the ones the account had. */
  async newRecoveryCodes(userId: string, dto: SecondFactorProofRequest): Promise<RecoveryCodes> {
    const holder = await this.holderOf(userId, dto.currentPassword);
    await this.prove(holder, dto.code, notOn);
    const recoveryCodes = await this.factors.replaceRecoveryCodes(userId);
    if (!recoveryCodes) throw notOn();
    return { recoveryCodes };
  }

  /**
   * The operator takes the second factor off the account of an address,
   * for a holder who lost the app and the recovery codes. The account is
   * told, at the address it has.
   */
  async removeFor(address: string): Promise<void> {
    const holder = await this.prisma.user.findUnique({ where: { emailIndex: this.emails.indexOf(this.emails.normalise(address)) } });
    if (!holder || !(await this.factors.remove({ userId: holder.id }))) {
      throw new NotFoundException({ error: 'SECOND_FACTOR_NOT_FOUND', message: 'No account with that address has a second factor.' });
    }
    this.mail.sendSecondFactorOffNotice(this.addressOf(holder), 'operator', Locale.parse(holder.locale));
  }

  /**
   * What an account with a second factor gets for its password: not a
   * session, but the right to try a code, for a few minutes.
   */
  async challenge(userId: string): Promise<SecondFactorChallenge> {
    const challenge = randomBytes(32).toString('hex');
    await this.prisma.signInChallenge.create({
      data: { userId, tokenHash: sha256(challenge), expiresAt: new Date(Date.now() + CHALLENGE_SECONDS * 1000) },
    });
    return { secondFactor: { challenge, expiresIn: CHALLENGE_SECONDS } };
  }

  /**
   * The second step of signing in. Returns the account that has now shown
   * both its password and a code. A wrong code leaves the challenge good for
   * another try; a right one uses it up.
   */
  async answer(dto: SecondFactorSignInRequest) {
    const challenge = await this.prisma.signInChallenge.findUnique({ where: { tokenHash: sha256(dto.challenge) }, include: { user: true } });
    if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() < Date.now()) throw noSuchChallenge();
    // An account that switched its factor off meanwhile signs in with its password.
    await this.prove(challenge.user, dto.code, noSuchChallenge);
    const used = await this.prisma.signInChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw noSuchChallenge();
    return challenge.user;
  }

  /** Remove the challenges nobody can answer any more. Returns how many were removed. */
  async prune(): Promise<number> {
    return (await this.prisma.signInChallenge.deleteMany({ where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }] } })).count;
  }

  /** Pass with a code for the second factor of `holder`, or throw: `none` where the account has no second factor. */
  private async prove(holder: Holder, code: string, none: () => Error): Promise<void> {
    const check = await this.factors.check({ userId: holder.id }, code);
    if (check === null) throw none();
    const locale = Locale.parse(holder.locale);
    if (!check.accepted) {
      // Whoever got this far knows the password. If it is not the holder, the holder should hear of it.
      if (check.nowWaits) this.mail.sendSecondFactorFailedNotice(this.addressOf(holder), locale);
      throw wrongCode();
    }
    if (check.by === 'recovery-code') {
      this.mail.sendRecoveryCodeUsedNotice(this.addressOf(holder), await this.factors.recoveryCodesLeft(holder.id), locale);
    }
  }

  /** The account, for whoever shows its password. */
  private async holderOf(userId: string, password: string) {
    const holder = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!holder) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    if (!(await this.passwords.matches(password, holder.passwordHash))) {
      throw new UnauthorizedException({ error: 'INVALID_PASSWORD', message: 'Current password is incorrect.' });
    }
    return holder;
  }

  private addressOf(holder: Holder): string {
    return this.emails.open(holder.emailEncrypted, holder.id);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
