// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { rmSync } from 'node:fs';
import { request, type FullConfig } from '@playwright/test';
import { anAccount, keepAccounts, STATE, type Account } from './accounts';

/** How long the catalogue of a new instance may take to fill, in seconds. */
const CATALOGUE_WAIT = 300;

/**
 * An instance that was just installed has an empty catalogue, and no plan
 * comes of that; one that was brought up to a newer version may hold the
 * catalogue of the older one, without what the newer one's data says of the
 * ingredients. Filling it, and bringing it up to its data, is the
 * administrator's step after an installation and after an upgrade, and it is
 * taken here the same way when the run was given the administrator's name
 * and password. Without them the instance is taken to have its catalogue.
 */
async function aCatalogue(baseURL: string): Promise<void> {
  const user = process.env.E2E_ADMIN_USER;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!user || !password) return;
  // The panel takes a sign-in only from the application's own pages.
  const admin = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
  });
  try {
    const signedIn = await admin.post('/api/admin/session', { data: { user, password } });
    if (!signedIn.ok())
      throw new Error(
        `The administrator's sign-in answered ${signedIn.status()}: ${await signedIn.text()}`,
      );
    const stats = (await (await admin.get('/api/admin/stats')).json()) as {
      counts: { recipes: number };
      seed: { updateAvailable: boolean };
    };
    if (stats.counts.recipes > 0 && !stats.seed.updateAvailable) return;

    const started = await admin.post('/api/admin/db/update');
    if (!started.ok())
      throw new Error(`The catalogue update answered ${started.status()}: ${await started.text()}`);
    for (let waited = 0; ; waited += 1) {
      const state = (await (await admin.get('/api/admin/db/update/status')).json()) as {
        status: string;
        error: string | null;
      };
      if (state.status === 'done') return;
      if (state.status === 'error' || waited === CATALOGUE_WAIT)
        throw new Error(`The catalogue update did not finish: ${state.error ?? state.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await admin.delete('/api/admin/session').catch(() => undefined);
    await admin.dispose();
  }
}

/**
 * One account for each project, made once for the run. A test that fails
 * costs its worker, and the next worker must not sign up again: an instance
 * takes ten sign-ups a minute from one address.
 */
export default async function setup(config: FullConfig): Promise<void> {
  rmSync(STATE, { recursive: true, force: true });
  await aCatalogue(config.projects[0]!.use.baseURL!);
  const accounts: Record<string, Account> = {};
  for (const project of config.projects) {
    const api = await request.newContext({ baseURL: project.use.baseURL });
    accounts[project.name] = await anAccount(api, project.name);
    await api.dispose();
  }
  keepAccounts(accounts);
}
