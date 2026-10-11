// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiKeyService } from '../ai/ai-key.service.js';
import { openKey, sealKey } from '../ai/key-cipher.js';
import { AccountEmail } from '../auth/account-email.js';
import { AddressResealService } from '../auth/address-reseal.service.js';
import { resetDatabase } from '../testing/database.js';
import { aUser, type TestUser } from '../testing/factories.js';
import { ciphertextWrittenBefore } from '../testing/old-ciphertext.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { deriveKey } from './crypto.js';

// The secrets of the test application.
const EMAIL_KEY = deriveKey('b2'.repeat(32), 'email-encryption');
const AI_SECRET = 'a1'.repeat(32);
const ANOTHER_SECRET = 'c3'.repeat(32);

describe('what was encrypted before a value was sealed for its account', () => {
  let t: TestApp;
  let emails: AccountEmail;
  let first: TestUser;
  let second: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    emails = t.app.get(AccountEmail);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    first = await aUser(t);
    second = await aUser(t);
  });

  const addressOf = async (id: string): Promise<string> => (await t.prisma.user.findUniqueOrThrow({ where: { id } })).emailEncrypted;

  describe('addresses', () => {
    const run = () => t.app.get(AddressResealService).run();

    it('are sealed for the account each belongs to, and read as before', async () => {
      await t.prisma.user.update({ where: { id: first.id }, data: { emailEncrypted: ciphertextWrittenBefore(first.email, EMAIL_KEY) } });

      expect(await run()).toEqual({ sealed: 1, unreadable: 0 });

      const sealed = await addressOf(first.id);
      expect(emails.isBound(sealed)).toBe(true);
      expect(emails.open(sealed, first.id)).toBe(first.email);
      expect(() => emails.open(sealed, second.id)).toThrow();
    });

    it('are left alone where they are sealed already', async () => {
      const before = [await addressOf(first.id), await addressOf(second.id)];

      expect(await run()).toEqual({ sealed: 0, unreadable: 0 });

      expect([await addressOf(first.id), await addressOf(second.id)]).toEqual(before);
    });

    it('are left as they are, and counted, where they cannot be read', async () => {
      const foreign = ciphertextWrittenBefore(first.email, deriveKey(ANOTHER_SECRET, 'email-encryption'));
      await t.prisma.user.update({ where: { id: first.id }, data: { emailEncrypted: foreign } });
      await t.prisma.user.update({ where: { id: second.id }, data: { emailEncrypted: ciphertextWrittenBefore(second.email, EMAIL_KEY) } });

      expect(await run()).toEqual({ sealed: 1, unreadable: 1 });

      expect(await addressOf(first.id)).toBe(foreign);
      expect(emails.open(await addressOf(second.id), second.id)).toBe(second.email);
    });

    it('are sealed as what they are where they wait to be confirmed', async () => {
      const token = await t.prisma.emailChangeToken.create({
        data: {
          userId: first.id,
          newEmailEncrypted: ciphertextWrittenBefore('moved@example.test', EMAIL_KEY),
          newEmailIndex: emails.indexOf('moved@example.test'),
          tokenHash: 'f0'.repeat(32),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      expect(await run()).toEqual({ sealed: 1, unreadable: 0 });

      const sealed = (await t.prisma.emailChangeToken.findUniqueOrThrow({ where: { id: token.id } })).newEmailEncrypted;
      expect(emails.openPending(sealed, first.id)).toBe('moved@example.test');
      expect(() => emails.open(sealed, first.id)).toThrow();
    });

    it('are all reached, however many there are', async () => {
      // More than one page of them.
      const many = Array.from({ length: 230 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        emailIndex: emails.indexOf(`bulk-${i}@example.test`),
        emailEncrypted: ciphertextWrittenBefore(`bulk-${i}@example.test`, EMAIL_KEY),
        passwordHash: 'x',
        displayName: `Bulk ${i}`,
      }));
      await t.prisma.user.createMany({ data: many });

      expect(await run()).toEqual({ sealed: 230, unreadable: 0 });
      expect(await t.prisma.user.count({ where: { NOT: { emailEncrypted: { startsWith: 'v2:' } } } })).toBe(0);
      expect(emails.open(await addressOf(many[229]!.id), many[229]!.id)).toBe('bulk-229@example.test');
    });
  });

  describe('provider keys', () => {
    const run = () => t.app.get(AiKeyService).resealKeys();
    const aKey = (user: TestUser, provider: 'openai' | 'anthropic' | 'openrouter', encryptedKey: string) =>
      t.prisma.aiProviderConfig.create({ data: { userId: user.id, provider, model: 'm', encryptedKey } });
    const keyOf = async (id: string): Promise<string> => (await t.prisma.aiProviderConfig.findUniqueOrThrow({ where: { id } })).encryptedKey!;
    /** The id `sealKey` puts in front of a key sealed under the application's secret. */
    const secretId = sealKey('x', AI_SECRET, null).split(':')[0]!;

    it('are sealed for the account each belongs to, whichever of the earlier forms they have', async () => {
      const oldest = await aKey(first, 'openai', ciphertextWrittenBefore('sk-oldest', AI_SECRET));
      const withId = await aKey(first, 'anthropic', `${secretId}:${ciphertextWrittenBefore('sk-with-id', AI_SECRET)}`);
      const current = await aKey(second, 'openai', sealKey('sk-current', AI_SECRET, second.id));
      const currentBefore = await keyOf(current.id);

      expect(await run()).toEqual({ sealed: 2, unreadable: 0 });

      expect(openKey(await keyOf(oldest.id), AI_SECRET, first.id)).toEqual({ ok: true, key: 'sk-oldest' });
      expect(openKey(await keyOf(withId.id), AI_SECRET, first.id)).toEqual({ ok: true, key: 'sk-with-id' });
      expect(openKey(await keyOf(oldest.id), AI_SECRET, second.id).ok).toBe(false);
      expect(await keyOf(current.id)).toBe(currentBefore);
      expect(await run()).toEqual({ sealed: 0, unreadable: 0 });
    });

    it('are left as they are, and counted, where they were sealed under another secret', async () => {
      const foreign = `${sealKey('x', ANOTHER_SECRET, null).split(':')[0]!}:${ciphertextWrittenBefore('sk-elsewhere', ANOTHER_SECRET)}`;
      const row = await aKey(first, 'openrouter', foreign);

      expect(await run()).toEqual({ sealed: 0, unreadable: 1 });
      expect(await keyOf(row.id)).toBe(foreign);
    });

    it('leave a provider without a key alone', async () => {
      await t.prisma.aiProviderConfig.create({ data: { userId: first.id, provider: 'ollama', model: 'm', baseUrl: 'http://ollama.example.test:11434' } });

      expect(await run()).toEqual({ sealed: 0, unreadable: 0 });
    });
  });
});
