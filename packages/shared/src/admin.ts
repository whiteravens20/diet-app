// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the administrator's panel is told: whether it is on, how a request
 * reached the API, who may use the operator's AI provider, what the catalogue holds and what its plans reach, and
 * where the two long jobs of the panel stand (the catalogue update and the
 * food import).
 */
import * as z from './zod.js';
import { OperatorAiAccess } from './ai.js';
import { emailAddress } from './auth.js';
import { DietType, MealType } from './enums.js';
import { Macros } from './nutrition.js';

/** Whether the panel is on, and what to tell the operator when it is not. Never the configured password. */
export const AdminStatus = z.object({
  enabled: z.boolean(),
  message: z.string().nullable(),
});
export type AdminStatus = z.infer<typeof AdminStatus>;

/** Who may use the operator's AI provider, as the admin panel shows it. */
export const AdminOperatorAi = z.object({
  /** `AI_ADMIN_ACCESS`. */
  access: OperatorAiAccess,
  /** Whether mail is set up: without it every address counts as confirmed when its account is made. */
  mailConfigured: z.boolean(),
  /** How many accounts the operator has approved. */
  approved: z.number().int().min(0),
});
export type AdminOperatorAi = z.infer<typeof AdminOperatorAi>;

/** The account whose use of the operator's AI provider is approved, or no longer approved. */
export const OperatorAiApproval = z.object({ email: emailAddress }).strict();
export type OperatorAiApproval = z.infer<typeof OperatorAiApproval>;

/** How a request reached the API, for an operator setting up a reverse proxy. */
export const AdminConnection = z.object({
  /** The address requests are counted against: the client's, as far as `TRUST_PROXY` lets it be known. */
  clientAddress: z.string().nullable(),
  /** The address of the connection itself: the proxy nearest to the API, or the client when there is none. */
  peerAddress: z.string().nullable(),
  /** `X-Forwarded-For` as it arrived, or null when the request carried none. */
  forwardedFor: z.string().nullable(),
  /** How many addresses that header holds: one for every proxy that wrote into it. */
  forwardedHops: z.number().int().min(0),
  /** What `TRUST_PROXY` is set to: `false`, a number of proxies, or their addresses. */
  trustProxy: z.union([z.literal(false), z.number().int(), z.array(z.string())]),
  /** The request came through a proxy and is counted against that proxy's address: every client behind it shares one allowance. */
  countedAsProxy: z.boolean(),
  /** `TRUST_PROXY` counts more proxies than wrote into the header: a visitor can write the address they are counted by. */
  overTrusted: z.boolean(),
});
export type AdminConnection = z.infer<typeof AdminConnection>;

/** A number for each meal of each diet. */
export const CoverageMatrix = z.record(DietType, z.record(MealType, z.number().int().min(0)));
export type CoverageMatrix = z.infer<typeof CoverageMatrix>;

/** What the plans of a diet reach: the shares of the average day's energy, and how far that is from the diet's split. */
export const MacroReach = Macros.extend({
  distance: z.number().min(0),
  /** Of what the weeks buy in packs that do not keep, the share they use. Null where they buy none. */
  packsUsed: z.number().min(0).max(1).nullable(),
});
export type MacroReach = z.infer<typeof MacroReach>;

/** The curated data as the database holds it and as the files are now. */
export const AdminStats = z.object({
  counts: z.object({ ingredients: z.number().int(), recipes: z.number().int(), substitutions: z.number().int() }),
  /** How many recipes each diet has for each meal. */
  coverage: CoverageMatrix,
  /** How many a release needs for each. */
  coverageTarget: z.number().int(),
  /** How many recipe drafts wait in the queue for each. */
  coverageWaiting: CoverageMatrix,
  /**
   * For each diet, what its plans aim at and what they reach with the recipes
   * there are, as shares of a day's energy. `reached` is null where no plan
   * can be made. A diet whose `distance` is `outOfReach` or more needs recipes
   * that fit it.
   */
  macros: z.object({
    outOfReach: z.number(),
    diets: z.record(DietType, z.object({ target: Macros, reached: MacroReach.nullable() })),
  }),
  seed: z.object({
    lastSeededAt: z.string().datetime().nullable(),
    storedHash: z.string().nullable(),
    currentHash: z.string(),
    updateAvailable: z.boolean(),
    /** Each data file: whether it is there, and its size. */
    files: z.array(z.object({ name: z.string(), present: z.boolean(), bytes: z.number().int().min(0) })),
  }),
});
export type AdminStats = z.infer<typeof AdminStats>;

/** Where a long job of the panel stands. */
export const JobStatus = z.enum(['idle', 'running', 'done', 'error']);
export type JobStatus = z.infer<typeof JobStatus>;

/** Where the catalogue update stands, and what it did once it is done. */
export const CatalogueUpdateState = z.object({
  status: JobStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The stage the update is at (`ingredients`, `recipes`, ...). */
  stage: z.string().nullable(),
  /** How far the stage is, when the stage knows its total. */
  current: z.number().int().nullable(),
  total: z.number().int().nullable(),
  /** Once the update is done. */
  result: z
    .object({
      /** Rows the data dropped and nothing referred to. */
      deletedRecipes: z.number().int(),
      deletedIngredients: z.number().int(),
      /** Rows the data dropped while user data still refers to them: kept, hidden. */
      retiredRecipes: z.number().int(),
      retiredIngredients: z.number().int(),
      /** Profiles whose preferences or favourite sets pointed at rows that are gone. */
      repairedProfiles: z.number().int(),
      counts: z.object({ ingredients: z.number().int(), recipes: z.number().int(), substitutions: z.number().int() }),
      hash: z.string(),
      seededAt: z.string(),
    })
    .nullable(),
  /** Once the update has failed. */
  error: z.string().nullable(),
});
export type CatalogueUpdateState = z.infer<typeof CatalogueUpdateState>;

/** Why a food import failed, so that the panel can say what to do about it. */
export const FoodImportFailure = z.enum(['over_limit', 'key_refused', 'unavailable', 'not_writable', 'failed']);
export type FoodImportFailure = z.infer<typeof FoodImportFailure>;

/** Where the import of foods from USDA FoodData Central stands. */
export const FoodImportState = z.object({
  status: JobStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The page the import is at and how many there are, while it runs. */
  page: z.number().int().nullable(),
  totalPages: z.number().int().nullable(),
  kept: z.number().int(),
  skipped: z.number().int(),
  excluded: z.number().int(),
  /** Foods left out because their record is incomplete; `result.refusals` names the first of them. */
  refused: z.number().int(),
  /** The data types of this run, with commas between them. */
  dataTypes: z.string().nullable(),
  /** The key was the demonstration key. */
  demoKey: z.boolean(),
  /** Once the import is done. */
  result: z
    .object({
      kept: z.number().int(),
      /** Foods the source lists twice under one description. */
      skipped: z.number().int(),
      /** Foods of categories that are dishes or products, not ingredients. */
      excluded: z.number().int(),
      refused: z.number().int(),
      refusals: z.array(z.object({ name: z.string(), reason: z.string() })),
      totalPages: z.number().int(),
      outFile: z.string(),
      dataTypes: z.string(),
      demoKey: z.boolean(),
    })
    .nullable(),
  /** Once the import has failed: what went wrong, and why. */
  error: z.string().nullable(),
  errorReason: FoodImportFailure.nullable(),
  /** How long the source asks to wait before the next try, in seconds, when it said so. */
  retryAfterSeconds: z.number().nullable(),
});
export type FoodImportState = z.infer<typeof FoodImportState>;

/** How many rows a request changed. */
export const Updated = z.object({ updated: z.number().int().min(0) });
export type Updated = z.infer<typeof Updated>;

/** What the health probe answers: 200 with the database up, 503 with it down. */
export const Health = z.object({
  status: z.string(),
  db: z.enum(['up', 'down']),
  time: z.string().datetime(),
});
export type Health = z.infer<typeof Health>;
