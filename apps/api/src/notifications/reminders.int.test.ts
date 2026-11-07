// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { type CookingReminderPayload, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { CookingReminderService } from './cooking-reminder.service.js';

describe('the reminders that keep the hours of an account', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let cooking: CookingReminderService;
  const at = (moment: string) => new Date(moment);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    cooking = t.app.get(CookingReminderService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const zone = (timeZone: string | null) =>
    t.prisma.user.update({ where: { id: user.id }, data: { timeZone } });
  const reminders = (type: 'water_reminder' | 'cooking_reminder') =>
    t.prisma.notification.findMany({
      where: { profileId: profile.id, type },
      orderBy: { createdAt: 'asc' },
    });

  describe('cooking ahead', () => {
    beforeEach(async () => {
      await zone('UTC');
    });

    it('reminds once, from 18 the evening before, of every dish cooked ahead tomorrow', async () => {
      const plan = await aPlan(t, user, profile, {
        startDate: '2026-11-10',
        durationDays: 4,
        mealPrepFriendly: true,
      });
      const cookedThere = plan.days[0]!.meals.filter((meal) => meal.cookAhead === 'cook');
      expect(cookedThere.length).toBeGreaterThan(0);

      expect(await cooking.scan(at('2026-11-09T17:59:00Z'))).toBe(0);
      expect(await cooking.scan(at('2026-11-09T18:05:00Z'))).toBe(1);
      expect(await cooking.scan(at('2026-11-09T21:00:00Z'))).toBe(0);

      const [made] = await reminders('cooking_reminder');
      const payload = made!.payload as CookingReminderPayload;
      expect(payload.date).toBe('2026-11-10');
      expect(payload.dishes.map((dish) => dish.plannedMealId).sort()).toEqual(
        cookedThere.map((meal) => meal.id).sort(),
      );
      for (const dish of payload.dishes) {
        expect(dish.dish.length).toBeGreaterThan(0);
        expect(['2026-11-10', '2026-11-11']).toContain(dish.alsoDate);
      }
    });

    it('reminds nobody who switched it off, nor of a plan that is not for cooking ahead', async () => {
      await aPlan(t, user, profile, { startDate: '2026-11-10', durationDays: 4 });
      expect(await cooking.scan(at('2026-11-09T18:30:00Z'))).toBe(0);
      await aPlan(t, user, profile, {
        startDate: '2026-11-10',
        durationDays: 4,
        mealPrepFriendly: true,
      });
      await t.prisma.profile.update({
        where: { id: profile.id },
        data: { cookingReminders: false },
      });
      expect(await cooking.scan(at('2026-11-09T18:30:00Z'))).toBe(0);
    });
  });
});
