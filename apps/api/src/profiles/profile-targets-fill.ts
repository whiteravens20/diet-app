// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TARGET_COLUMNS, targetOf } from './profile-targets.js';

/**
 * A profile with no row of what it aimed at, made before such rows were kept, is given one from its first day with
 * what it aims at now, once, when the application starts: its past days keep from then on what they show, whatever
 * later changes the profile or the way a target is worked out. A start that finds none writes nothing.
 */
@Injectable()
export class ProfileTargetsFill implements OnApplicationBootstrap {
  private readonly logger = new Logger('Profiles');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const filled = await this.fill();
      if (filled > 0)
        this.logger.log(`Wrote down what ${filled} profiles aim at, from their first day.`);
    } catch (err) {
      // A start goes on without it: such a profile's past days read it as it stands meanwhile.
      this.logger.error(`Could not write down what profiles aim at: ${String(err)}`);
    }
  }

  /** Gives every profile with no row one from its first day; answers how many it wrote. */
  async fill(): Promise<number> {
    const profiles = await this.prisma.profile.findMany({
      where: { targets: { none: {} } },
      select: { id: true, createdAt: true, ...TARGET_COLUMNS },
    });
    if (profiles.length === 0) return 0;
    const written = await this.prisma.profileTarget.createMany({
      data: profiles.map((profile) => ({
        profileId: profile.id,
        from: new Date(profile.createdAt.toISOString().slice(0, 10)),
        target: targetOf(profile),
      })),
      // Another start, or a profile's own first row written meanwhile, keeps its row.
      skipDuplicates: true,
    });
    return written.count;
  }
}
