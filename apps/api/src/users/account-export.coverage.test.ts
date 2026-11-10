// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every table whose rows belong to an account, through the account or one of its profiles, is
 * in the account's file or is left out for a reason written here. A new table of that kind
 * fails this test until somebody decides which it is.
 */

/** The list of the file each such table goes into. */
const IN_THE_FILE: Record<string, string> = {
  Profile: 'profiles',
  ProfilePreference: 'profiles',
  WeightEntry: 'weights',
  WaterEntry: 'water',
  DiaryEntry: 'diary',
  InventoryItem: 'pantry',
  Favorite: 'markedRecipes',
  FavoriteSet: 'favoriteSets',
  OwnProduct: 'ownProducts',
  Recipe: 'ownRecipes',
  MealPlan: 'plans',
  JointPlan: 'plans',
  HouseholdList: 'householdLists',
  Notification: 'notifications',
  AiProviderConfig: 'aiProviders',
  AiUsageLog: 'aiCalls',
  RefreshToken: 'sessions',
  SecondFactor: 'account',
};

/** Why the others are not in it. */
const LEFT_OUT: Record<string, string> = {
  IdempotencyKey: 'a request answered once, kept so that its repeat is answered alike',
  BrowserSignInCode: 'a code that signs in: it proves who somebody is',
  SignInChallenge: 'the second step of a sign-in under way: it proves who somebody is',
  PasswordResetToken: 'a link that sets a new password: it proves who somebody is',
  EmailVerificationToken: 'a link that confirms the address: it proves who somebody is',
  EmailChangeToken: 'a link that moves the account to a new address: it proves who somebody is',
  Product: "a product the base accepted from the account: it is nobody's any more",
  OwnProductChange: 'when the account wrote or sent a product, kept for the limits of a day',
  ProductLookup: 'that the account asked about a code, kept for the limits of a lookup; no code',
};

const ROOT = join(__dirname, '..', '..');
const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const exporter = readFileSync(join(__dirname, 'account-export.service.ts'), 'utf8');

/** The models with a relation of their own to an account or to a profile. */
function ofAnAccount(text: string): string[] {
  return [...text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(([, , body]) => /^\s+\w+\s+(User|Profile)\??\s+@relation\(fields:/m.test(body!))
    .map(([, name]) => name!);
}

describe("the account's file", () => {
  it('holds every table of an account, or says why it does not', () => {
    const undecided = ofAnAccount(schema).filter(
      (model) => !(model in IN_THE_FILE) && !(model in LEFT_OUT),
    );
    expect(undecided).toEqual([]);
  });

  it('names only tables there are, and lists the file writes', () => {
    const models = new Set(ofAnAccount(schema));
    expect(Object.keys({ ...IN_THE_FILE, ...LEFT_OUT }).filter((m) => !models.has(m))).toEqual([]);
    const written = new Set(
      [...exporter.matchAll(/(?:list|field)\(\s*'(\w+)'/g)].map(([, name]) => name),
    );
    expect(Object.values(IN_THE_FILE).filter((name) => !written.has(name))).toEqual([]);
  });

  it('finds a table of a profile that nobody decided about', () => {
    const added = `${schema}\nmodel SleepEntry {\n  id String @id\n  profile Profile @relation(fields: [profileId], references: [id])\n  profileId String\n}\n`;
    expect(ofAnAccount(added).filter((m) => !(m in IN_THE_FILE) && !(m in LEFT_OUT))).toEqual([
      'SleepEntry',
    ]);
  });
});
