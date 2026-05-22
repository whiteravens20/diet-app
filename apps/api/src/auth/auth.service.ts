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
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TurnstileService } from './turnstile.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly turnstile: TurnstileService,
  ) {}

  async register(dto: RegisterRequest): Promise<AuthResponse> {
    await this.assertHuman(dto.turnstileToken);
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' });

    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, rounds),
        displayName: dto.displayName,
      },
    });
    return this.issueTokens(user);
  }

  async login(dto: LoginRequest): Promise<AuthResponse> {
    await this.assertHuman(dto.turnstileToken);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Always run a hash comparison to keep the response time uniform.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidina');
    if (!user || !ok) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }
    return this.issueTokens(user);
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
    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Always returns 200 — never reveals whether the email exists. */
  async requestPasswordReset(dto: PasswordResetRequest): Promise<void> {
    await this.assertHuman(dto.turnstileToken);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
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
    this.logger.log(`Password reset link for ${user.email}: ${link}`);
  }

  async confirmPasswordReset(dto: PasswordResetConfirm): Promise<void> {
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
    });
    if (!token || token.usedAt || token.expiresAt < new Date()) {
      throw new BadRequestException({ error: 'INVALID_RESET_TOKEN', message: 'Reset link is invalid or expired.' });
    }
    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: token.userId },
        data: { passwordHash: await bcrypt.hash(dto.password, rounds) },
      }),
      this.prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
      // Invalidate every active session.
      this.prisma.refreshToken.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  private async assertHuman(token: string | undefined): Promise<void> {
    if (!(await this.turnstile.verify(token))) {
      throw new BadRequestException({ error: 'TURNSTILE_FAILED', message: 'Anti-abuse check failed.' });
    }
  }

  private async issueTokens(user: {
    id: string;
    email: string;
    displayName: string;
    role: 'user' | 'admin';
    emailVerified: boolean;
  }): Promise<AuthResponse> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
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
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        emailVerified: user.emailVerified,
      },
      tokens: { accessToken, refreshToken, expiresIn: accessTtl },
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
