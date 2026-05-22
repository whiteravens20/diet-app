import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type {
  AuthResponse,
  LoginRequest,
  PasswordResetConfirm,
  PasswordResetRequest,
  RegisterRequest,
} from '@diet-app/shared';
import * as bcrypt from 'bcryptjs';
import { blindIndex, decrypt, deriveKey, encrypt, pepperPassword } from '../common/crypto.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TurnstileService } from './turnstile.service.js';

/** A bcrypt hash of a constant value, for a uniform-time compare on a miss. */
const DUMMY_HASH = '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidina';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Purpose-specific keys derived from the single DATA_ENCRYPTION_SECRET.
  private readonly emailKey: string;
  private readonly emailIndexKey: string;
  private readonly pepperKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly turnstile: TurnstileService,
  ) {
    const master = this.config.get('DATA_ENCRYPTION_SECRET', { infer: true });
    this.emailKey = deriveKey(master, 'email-encryption');
    this.emailIndexKey = deriveKey(master, 'email-blind-index');
    this.pepperKey = deriveKey(master, 'password-pepper');
  }

  async register(dto: RegisterRequest): Promise<AuthResponse> {
    await this.assertHuman(dto.turnstileToken);
    const email = normalizeEmail(dto.email);
    const emailIndex = blindIndex(email, this.emailIndexKey);

    const existing = await this.prisma.user.findUnique({ where: { emailIndex } });
    if (existing) throw new ConflictException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' });

    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const user = await this.prisma.user.create({
      data: {
        emailIndex,
        emailEncrypted: encrypt(email, this.emailKey),
        passwordHash: await this.hashPassword(dto.password, rounds),
        displayName: dto.displayName,
      },
    });
    return this.issueTokens(user, email);
  }

  async login(dto: LoginRequest): Promise<AuthResponse> {
    await this.assertHuman(dto.turnstileToken);
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { emailIndex: blindIndex(email, this.emailIndexKey) },
    });
    // Always run a hash comparison to keep the response time uniform.
    const ok = await bcrypt.compare(
      pepperPassword(dto.password, this.pepperKey),
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !ok) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }
    return this.issueTokens(user, email);
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ error: 'INVALID_REFRESH', message: 'Refresh token rejected.' });
    }
    // Rotate: revoke the used token, issue a fresh pair.
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(stored.user, decrypt(stored.user.emailEncrypted, this.emailKey));
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Always returns 200 — never reveals whether the email exists. */
  async requestPasswordReset(dto: PasswordResetRequest): Promise<void> {
    await this.assertHuman(dto.turnstileToken);
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { emailIndex: blindIndex(email, this.emailIndexKey) },
    });
    if (!user) return;

    const raw = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + 3_600_000), // 1 hour
      },
    });
    const link = `${this.config.get('APP_URL', { infer: true })}/reset-password?token=${raw}`;
    // TODO(email): deliver via SMTP when configured. Dev mode logs the link.
    this.logger.log(`Password reset link for ${email}: ${link}`);
  }

  async confirmPasswordReset(dto: PasswordResetConfirm): Promise<void> {
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
    });
    if (!token || token.usedAt || token.expiresAt < new Date()) {
      throw new BadRequestException({ error: 'INVALID_RESET_TOKEN', message: 'Reset link is invalid or expired.' });
    }
    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const passwordHash = await this.hashPassword(dto.password, rounds);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
      // Invalidate every active session.
      this.prisma.refreshToken.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /** Peppers the password with an app-only key, then bcrypt-hashes it. */
  private hashPassword(password: string, rounds: number): Promise<string> {
    return bcrypt.hash(pepperPassword(password, this.pepperKey), rounds);
  }

  private async assertHuman(token: string | undefined): Promise<void> {
    if (!(await this.turnstile.verify(token))) {
      throw new BadRequestException({ error: 'TURNSTILE_FAILED', message: 'Anti-abuse check failed.' });
    }
  }

  private async issueTokens(
    user: { id: string; displayName: string; role: 'user' | 'admin'; emailVerified: boolean },
    email: string,
  ): Promise<AuthResponse> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email, role: user.role },
      { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: accessTtl },
    );
    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return {
      user: {
        id: user.id,
        email,
        displayName: user.displayName,
        role: user.role,
        emailVerified: user.emailVerified,
      },
      tokens: { accessToken, refreshToken, expiresIn: accessTtl },
    };
  }
}

/** Lowercased + trimmed, so the blind index is stable regardless of casing. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
