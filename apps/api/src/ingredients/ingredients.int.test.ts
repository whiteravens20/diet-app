// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Ingredient } from '@diet-app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the ingredient catalogue, as a client asks it', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    user = await aUser(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const ask = (query: Record<string, string | string[]>, locale = 'en') =>
    t.http().get('/api/ingredients').query(query).set(as(user)).set('Accept-Language', locale);
  const names = async (query: Record<string, string>, locale = 'en'): Promise<string[]> =>
    ((await ask(query, locale).expect(200)).body as Ingredient[]).map(
      (ingredient) => ingredient.name,
    );

  it("is listed by the name it shows, in the order of that language's alphabet", async () => {
    const polish = await names({}, 'pl');
    const english = await names({}, 'en');

    expect(polish).toHaveLength(english.length);
    expect(polish).toEqual([...polish].sort(new Intl.Collator('pl').compare));
    expect(english).toEqual([...english].sort(new Intl.Collator('en').compare));
    // A letter of its own in Polish: after every name with L, before those with M.
    expect(polish.indexOf('Łosoś')).toBeGreaterThan(polish.indexOf('Jogurt grecki'));
    expect(polish.indexOf('Łosoś')).toBeLessThan(polish.indexOf('Mleko pełne'));
    // And not in the order of the English names it does not show.
    expect(polish).not.toEqual(
      await Promise.all(english.map(async (name) => (await names({ search: name }, 'pl'))[0])),
    );
  });

  it('is searched by the name in the language of the request, and by the English one as well', async () => {
    expect(await names({ search: 'łoso' }, 'pl')).toEqual(['Łosoś']);
    expect(await names({ search: 'salm' }, 'pl')).toEqual(['Łosoś']);
    expect(await names({ search: 'salm' }, 'en')).toEqual(['Salmon']);
    expect(await names({ search: 'łoso' }, 'en')).toEqual([]);
    expect(await names({ search: '' }, 'en')).toHaveLength((await names({})).length);
  });

  it('takes the signs of a pattern for what they are: text', async () => {
    expect(await names({ search: '%' })).toEqual([]);
    expect(await names({ search: '_' })).toEqual([]);
    expect(await names({ search: 'sal_on' })).toEqual([]);
  });

  it('leaves a retired ingredient out of a search', async () => {
    const salmon = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'salmon' } });
    await t.prisma.ingredient.update({ where: { id: salmon.id }, data: { retiredAt: new Date() } });

    expect(await names({ search: 'salm' })).toEqual([]);

    await t.prisma.ingredient.update({ where: { id: salmon.id }, data: { retiredAt: null } });
  });

  it('answers the ingredients of a list of ids, by the name they show', async () => {
    const [rice, oats, salmon] = await Promise.all(
      ['white-rice', 'rolled-oats', 'salmon'].map((slug) =>
        t.prisma.ingredient.findFirstOrThrow({ where: { slug } }),
      ),
    );
    const ids = [rice!.id, oats!.id, salmon!.id].join(',');

    expect(await names({ ids }, 'pl')).toEqual(['Łosoś', 'Płatki owsiane', 'Ryż biały']);
    expect(await names({ ids: `${ids},` }, 'en')).toEqual(['Rolled oats', 'Salmon', 'White rice']);
    expect(await names({ ids: '00000000-0000-4000-8000-000000000000' })).toEqual([]);
  });

  it.each([
    ['an id that is none', { ids: 'white-rice' }, 'ids.0'],
    [
      'more ids than can be asked for at once',
      {
        ids: Array.from(
          { length: 201 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ).join(','),
      },
      'ids',
    ],
    ['a search of more than two hundred characters', { search: 'a'.repeat(201) }, 'search'],
  ])('refuses %s', async (_name, query, part) => {
    const refused = await ask(query).expect(400);

    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect(refused.body.issues[0].path).toBe(part);
  });

  it('refuses a part of the question that is given twice, instead of failing on it', async () => {
    expect((await ask({ search: ['oat', 'rice'] }).expect(400)).body.error).toBe(
      'VALIDATION_FAILED',
    );
    expect((await ask({ ids: ['a', 'b'] }).expect(400)).body.error).toBe('VALIDATION_FAILED');
  });
});
