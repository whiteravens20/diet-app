// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve as resolvePath } from 'node:path';
import type { InstanceDataState, InstanceMirror } from '@diet-app/shared';
import { PACKAGE_VERSION } from '../../../app-config/package-version.js';
import type { Env } from '../../../config/env.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { resolveDataDir } from '../../seed/data-hash.js';
import {
  exportInstanceData,
  manifestWrittenAt,
  notRestored,
  readableBy,
  readManifest,
} from './instance-export.js';
import { instanceDataState, restoreInstanceData, type RestoreResult } from './restore.js';
import { readMirror } from './mirror-report.js';

/** What writing the instance's files did: the files written, or why there are none. */
export interface FilesWritten {
  written: string[];
  /** `files-not-restored`, or what the file system said. What was done in the database stands. */
  error?: string;
}

/**
 * The instance's own files: written from its database after whatever changes
 * what they hold (`instance-export.ts`), read back by a restore, and described
 * to the panel. The version of the application they carry is the version of
 * its package, which says what shape they are in; `APP_VERSION` is a label.
 */
@Injectable()
export class InstanceFilesService {
  private readonly logger = new Logger(InstanceFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The instance's data directory. */
  get dir(): string {
    const raw = this.config.get('INSTANCE_DATA_DIR', { infer: true }) ?? 'instance-data';
    return resolvePath(process.cwd(), raw);
  }

  /** Write the files from the database. A failure is reported, never thrown. */
  async write(): Promise<FilesWritten> {
    try {
      const done = await exportInstanceData(
        this.prisma,
        this.dir,
        PACKAGE_VERSION,
        resolveDataDir(),
      );
      if (done.notRestored.length > 0) {
        this.logger.warn(
          `The instance's files were not written: ${done.notRestored.map((file) => file.file).join(', ')} hold recipes the library does not have`,
        );
        return { written: [], error: 'files-not-restored' };
      }
      return { written: done.written };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`The instance's files were not written: ${message}`);
      return { written: [], error: message };
    }
  }

  /** What the directory holds, which version wrote it, and what in it the library does not have. */
  async state(): Promise<InstanceDataState> {
    return {
      ...instanceDataState(this.dir),
      version: readManifest(this.dir)?.version ?? null,
      notRestored: (await notRestored(this.prisma, this.dir)).length,
    };
  }

  /** The copy of the files in a git repository, as the `mirror` service last reported it. */
  mirror(): InstanceMirror {
    const raw = this.config.get('MIRROR_REPORT_DIR', { infer: true }) ?? 'mirror-report';
    return readMirror(resolvePath(process.cwd(), raw), manifestWrittenAt(this.dir), new Date());
  }

  /**
   * Read the files back into the database, then write them again from it.
   * Files a newer version wrote are refused (409 `INSTANCE_DATA_NEWER`): this
   * version may not know what they hold.
   */
  async restore(): Promise<RestoreResult> {
    const manifest = readManifest(this.dir);
    if (manifest && !readableBy(PACKAGE_VERSION, manifest.version)) {
      throw new ConflictException({
        error: 'INSTANCE_DATA_NEWER',
        message: `The files were written by version ${manifest.version} of the application, newer than this one (${PACKAGE_VERSION}).`,
        details: { files: manifest.version, app: PACKAGE_VERSION },
      });
    }
    const result = await restoreInstanceData(this.prisma, this.dir);
    await this.write();
    return result;
  }
}
