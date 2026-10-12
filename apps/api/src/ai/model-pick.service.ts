// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MODEL_PICK_AUDIENCE, TOKEN_ALGORITHM } from '../auth/token-kinds.js';
import type { Env } from '../config/env.js';

/** What a model picked: a recipe for a meal of a plan as it stood, or a substitute for an ingredient of a meal. */
export type ModelPick =
  | { kind: 'meal'; meal: string; recipe: string; revision: number; reason: string | null }
  | { kind: 'ingredient'; meal: string; from: string; to: string; reason: string | null };

/** What a request does with a pick: the pick itself, without the model's reason, which only the note knows. */
export type PickTaken = ModelPick extends infer Pick ? (Pick extends unknown ? Omit<Pick, 'reason'> : never) : never;

/** How long a note is good for, in seconds: an offer is taken or left within the sitting it was made in. */
const LIFETIME = 2 * 60 * 60;

/**
 * A model is asked before anything is written: it picks a recipe to offer, or
 * a substitute to suggest, and a later request takes the pick. That request
 * is the one that writes, and what it writes has to say that a model chose.
 *
 * The API therefore signs a note with the pick and hands it out with it; the
 * request that takes the pick hands the note back. A client cannot make one,
 * cannot move one to another meal, recipe or account, and a note for a plan
 * that has changed since is no longer for the plan. Nothing is kept on the
 * server meanwhile, so any process of the API reads what another signed.
 */
@Injectable()
export class ModelPickService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The note for a pick a model made for this account. */
  sign(userId: string, pick: ModelPick): string {
    return this.jwt.sign(pick, { ...this.signing(), subject: userId, expiresIn: LIFETIME });
  }

  /**
   * What a request that hands a note back may write: nothing when it hands
   * none, the pick when the note is this account's and is for exactly what
   * the request does. Any other note is refused, so that a pick is never
   * written as a model's on a note for something else.
   */
  taken(userId: string, note: string | undefined, does: PickTaken): ModelPick | null {
    if (note === undefined) return null;
    const pick = this.read(userId, note) as (ModelPick & Record<string, unknown>) | null;
    const same = pick !== null && Object.entries(does).every(([key, value]) => pick[key] === value);
    if (!same) {
      throw new BadRequestException({ error: 'MODEL_PICK_INVALID', message: 'This suggestion is no longer good for what it was made for. Ask for another.' });
    }
    return pick;
  }

  private read(userId: string, note: string): ModelPick | null {
    try {
      const claims = this.jwt.verify<ModelPick & { sub?: unknown }>(note, { secret: this.signing().secret, algorithms: [TOKEN_ALGORITHM], audience: MODEL_PICK_AUDIENCE });
      return claims.sub === userId ? claims : null;
    } catch {
      return null;
    }
  }

  private signing(): { secret: string; algorithm: typeof TOKEN_ALGORITHM; audience: string } {
    return { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), algorithm: TOKEN_ALGORITHM, audience: MODEL_PICK_AUDIENCE };
  }
}
