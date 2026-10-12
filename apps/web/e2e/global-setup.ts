// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { rmSync } from 'node:fs';
import { request, type FullConfig } from '@playwright/test';
import { anAccount, keepAccounts, STATE, type Account } from './accounts';

/**
 * One account for each project, made once for the run. A test that fails
 * costs its worker, and the next worker must not sign up again: an instance
 * takes ten sign-ups a minute from one address.
 */
export default async function setup(config: FullConfig): Promise<void> {
  rmSync(STATE, { recursive: true, force: true });
  const accounts: Record<string, Account> = {};
  for (const project of config.projects) {
    const api = await request.newContext({ baseURL: project.use.baseURL });
    accounts[project.name] = await anAccount(api, project.name);
    await api.dispose();
  }
  keepAccounts(accounts);
}
