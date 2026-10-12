// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { accountOf, STATE, type Account } from './accounts';

export type AppLocale = 'en' | 'pl';

/** What a project sets beyond Playwright's own options. */
export interface Options {
  /** The language the application is shown in. */
  appLocale: AppLocale;
}

/** The texts of the application in a language, as the pages show them: a test finds things by them. */
export type Messages = Record<string, Record<string, unknown>>;
const messagesOf = (locale: AppLocale): Messages => JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${locale}.json`), 'utf8')) as Messages;

/** A browser that is signed in as the project's account, in its language and at its size. */
export interface Session {
  context: BrowserContext;
  page: Page;
}

/**
 * What the pages did against their content security policy since somebody
 * last asked: the directive, what was blocked, and on which page. A test that
 * leaves something here fails, whatever else it checked; one that breaks the
 * policy on purpose takes its violations away with `violationsSeen`.
 */
const violations: string[] = [];

/** The violations recorded since the last call, taken off the record. */
export function violationsSeen(): string[] {
  return violations.splice(0);
}

/** Record what every page of a browser does against its policy, from the first script of each page on. */
async function watchThePolicy(context: BrowserContext): Promise<void> {
  await context.exposeBinding('policyBroken', (_source, violation: string) => {
    violations.push(violation);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const where = event.sourceFile ? ` in ${new URL(event.sourceFile, location.href).pathname}:${event.lineNumber}` : '';
      const told = (window as unknown as { policyBroken: (violation: string) => void }).policyBroken;
      told(`${event.effectiveDirective} blocked ${event.blockedURI || 'something'} on ${location.pathname}${where}`);
    });
  });
}

/** Fill in the sign-in form the page shows, and send it. Where that leads is the caller's to wait for. */
export async function signInHere(page: Page, account: Pick<Account, 'email' | 'password'>, messages: Messages): Promise<void> {
  const auth = messages.auth as Record<string, string>;
  await page.getByLabel(auth.email!).fill(account.email);
  await page.getByLabel(auth.password!, { exact: true }).fill(account.password);
  await page.getByRole('button', { name: auth.signInButton! }).click();
}

async function signIn(page: Page, account: Account, locale: AppLocale): Promise<void> {
  await page.goto('/login');
  await signInHere(page, account, messagesOf(locale));
  await page.waitForURL('**/dashboard');
}

export const test = base.extend<{ appLocale: AppLocale; messages: Messages; anonymous: Page; sessionKept: void; policyKept: void }, { account: Account; session: Session }>({
  appLocale: ['en', { option: true }],

  messages: async ({ appLocale }, provide) => {
    await provide(messagesOf(appLocale));
  },

  /** A page of a visitor who is not signed in, with the language chosen: a first visit would load itself again to choose one. */
  anonymous: async ({ context, page, appLocale, baseURL }, provide) => {
    await context.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
    await watchThePolicy(context);
    await provide(page);
  },

  account: [
    async ({}, provide, workerInfo) => {
      await provide(accountOf(workerInfo.project.name));
    },
    { scope: 'worker' },
  ],

  /**
   * One session for all the tests of a project. Its cookies are written down
   * after every test, so that the worker that takes over after a failure goes
   * on with the session and signs in again only when it has ended.
   */
  session: [
    async ({ browser, account }, provide, workerInfo) => {
      const { baseURL, viewport, colorScheme, hasTouch, isMobile, reducedMotion } = workerInfo.project.use;
      const appLocale = (workerInfo.project.use as Options).appLocale ?? 'en';
      const kept = join(STATE, `${workerInfo.project.name}.json`);
      const context = await browser.newContext({ baseURL, viewport, colorScheme, hasTouch, isMobile, reducedMotion, storageState: existsSync(kept) ? kept : undefined });
      await context.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
      await watchThePolicy(context);
      const page = await context.newPage();
      const answered = page.waitForResponse((res) => res.url().endsWith('/api/users/me') && res.ok(), { timeout: 8_000 }).then(
        () => true,
        () => false,
      );
      await page.goto('/dashboard');
      // A browser without a session is sent to the sign-in form before the page
      // is rendered; one whose session has ended, when the page asks for it.
      const signedIn = !new URL(page.url()).pathname.startsWith('/login') && (await answered);
      if (!signedIn) await signIn(page, account, appLocale);
      await context.storageState({ path: kept });
      await provide({ context, page });
      await context.close();
    },
    { scope: 'worker' },
  ],

  sessionKept: [
    async ({ session }, provide, testInfo) => {
      await provide();
      await session.context.storageState({ path: join(STATE, `${testInfo.project.name}.json`) });
    },
    { auto: true },
  ],

  /** No page a test opened did anything its content security policy forbids. */
  policyKept: [
    async ({}, provide) => {
      violationsSeen();
      await provide();
      expect(violationsSeen(), 'what the pages did against their content security policy').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Wait until a page has what it loads after it is shown: no placeholder is left on it. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.skeleton')).toHaveCount(0);
}
