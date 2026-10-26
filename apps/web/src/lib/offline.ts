// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What an account looked at last, kept in this browser for when the server
 * cannot be reached: the plans, the shopping lists and what their pages read
 * beside them. The pages are then shown from it, and nothing but that is
 * possible, with one exception: a row of a shopping list can be ticked, and
 * the tick waits here until the server is back.
 *
 * It is kept for one account at a time, the one that is signed in. Signing
 * out removes it, and so does another account that signs in after.
 *
 * A browser keeps this for a page only over https, or on the machine itself
 * (the storage used is the one a service worker uses). An instance that is
 * reached over plain http has none of it, and works as it did.
 */
import { ApiClientError } from './http';

/** Where the browser is told whose data it keeps, and which ticks wait. Neither is a secret. */
const ACCOUNT = 'diet-app.offline.account';
const WAITING = 'diet-app.offline.waiting';
/** The storage of one account's answers. */
const PREFIX = 'diet-app.offline.';
const storeOf = (account: string): string => `${PREFIX}${account}`;
/** An answer is kept under an address of the application that nothing is ever asked at. */
const keyOf = (path: string): string => `/__kept__${path}`;

/** The most answers that are kept for an account, and the most ticks that wait. */
const MOST_ANSWERS = 80;
export const MOST_WAITING = 200;

/**
 * The answers that are kept: what the plan page, the shopping page and the
 * dashboard read, and what a recipe opened from a plan needs. Nothing else
 * of an account is written down here.
 */
const KEPT: readonly RegExp[] = [
  /^\/users\/me$/,
  /^\/config$/,
  /^\/profiles$/,
  /^\/profiles\/[^/?]+\/calories$/,
  /^\/meal-plans(\?.*)?$/,
  /^\/meal-plans\/[^/?]+$/,
  /^\/meal-plans\/(calendar|overview)\?/,
  /^\/weights\?/,
  /^\/shopping-lists\?/,
  /^\/favorites\?/,
  /^\/favorite-sets\?/,
  /^\/recipes\/[^/?]+$/,
];

/** A row of a shopping list that was ticked or unticked while the server could not be reached. */
export interface WaitingTick {
  listId: string;
  itemId: string;
  checked: boolean;
}

/** What became of the ticks that waited, once they were sent. */
export interface Replayed {
  sent: number;
  /** Refused by the server: the list they were made on is gone or has changed. They are dropped. */
  refused: number;
  /** Still waiting: the server could not be reached again. */
  left: number;
}

const local = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);
const stores = (): CacheStorage | null => (typeof caches === 'undefined' ? null : caches);

let serving = false;
const listeners = new Set<() => void>();
const told = (): void => listeners.forEach((listener) => listener());
const nowServing = (next: boolean): void => {
  if (serving === next) return;
  serving = next;
  told();
};

function waitingNow(): WaitingTick[] {
  try {
    const written = JSON.parse(local()?.getItem(WAITING) ?? '[]') as unknown;
    return Array.isArray(written) ? (written as WaitingTick[]) : [];
  } catch {
    return [];
  }
}

function writeWaiting(ticks: WaitingTick[]): void {
  if (ticks.length === 0) local()?.removeItem(WAITING);
  else local()?.setItem(WAITING, JSON.stringify(ticks));
  told();
}

/** Remove what was kept for an account, or for every account but `except`. */
async function drop(except: string | null): Promise<void> {
  const all = stores();
  if (!all) return;
  for (const name of await all.keys())
    if (name.startsWith(PREFIX) && name !== (except === null ? null : storeOf(except)))
      await all.delete(name);
}

export const offline = {
  /** Whether this browser keeps anything for the page at all. */
  get possible(): boolean {
    return stores() !== null && local() !== null;
  },

  /** The account whose answers are kept here, when there is one. */
  get account(): string | null {
    return this.possible ? (local()?.getItem(ACCOUNT) ?? null) : null;
  },

  /** True while what the pages show was read from here: the server could not be reached for it. */
  get serving(): boolean {
    return serving;
  },

  /** The ticks that wait for the server, in the order they were made. */
  get waiting(): WaitingTick[] {
    return waitingNow();
  },

  /** Be told when the pages begin or stop being served from here, and when a tick is added or sent. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * The account that is signed in in this browser. What was kept for another
   * one is removed, with the ticks it left waiting.
   */
  async belongsTo(account: string): Promise<void> {
    if (!this.possible) return;
    if (this.account !== account) {
      local()?.setItem(ACCOUNT, account);
      writeWaiting([]);
    }
    await drop(account);
  },

  /** Nobody is signed in any more: nothing of the account stays. The pointer goes at once, the storage as soon as the browser gets to it. */
  async forget(): Promise<void> {
    local()?.removeItem(ACCOUNT);
    local()?.removeItem(WAITING);
    nowServing(false);
    told();
    await drop(null);
  },

  /** Whether the answer to a path is one that is kept. */
  keeps(path: string): boolean {
    return KEPT.some((kept) => kept.test(path));
  },

  /** Keep an answer of the API for the account that is signed in. */
  async remember(path: string, answer: unknown): Promise<void> {
    const account = this.account;
    const all = stores();
    if (!account || !all || !this.keeps(path) || answer === undefined) return;
    try {
      const store = await all.open(storeOf(account));
      const key = keyOf(path);
      // Taken out and put in again, so that what was read last is kept longest.
      await store.delete(key);
      await store.put(
        key,
        new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }),
      );
      const keys = await store.keys();
      for (const oldest of keys.slice(0, Math.max(0, keys.length - MOST_ANSWERS)))
        await store.delete(oldest);
    } catch {
      // A browser that is out of room, or one that takes the storage away, keeps nothing: the pages work as without it.
    }
  },

  /** The answer that was kept for a path, if one was. */
  async recall<Answer>(path: string): Promise<{ found: true; answer: Answer } | { found: false }> {
    const account = this.account;
    const all = stores();
    if (!account || !all || !this.keeps(path)) return { found: false };
    try {
      const kept = await (await all.open(storeOf(account))).match(keyOf(path));
      return kept ? { found: true, answer: (await kept.json()) as Answer } : { found: false };
    } catch {
      return { found: false };
    }
  },

  /**
   * Ask the API, and keep what it answers; when it cannot be reached, answer
   * with what it said last. A refusal of the API is a refusal, kept answer
   * or not: only silence is answered from here.
   */
  async through<Answer>(path: string, ask: () => Promise<Answer>): Promise<Answer> {
    try {
      const answer = await ask();
      nowServing(false);
      void this.remember(path, answer);
      return answer;
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== 'NETWORK') throw error;
      const kept = await this.recall<Answer>(path);
      if (!kept.found) throw error;
      nowServing(true);
      return kept.answer;
    }
  },

  /**
   * Keep a tick for when the server is back. A row that is ticked and then
   * unticked waits once, with what was said last. False when no more can wait.
   */
  wait(tick: WaitingTick): boolean {
    if (!this.account) return false;
    const others = waitingNow().filter(
      (waiting) => waiting.listId !== tick.listId || waiting.itemId !== tick.itemId,
    );
    if (others.length >= MOST_WAITING) return false;
    writeWaiting([...others, tick]);
    return true;
  },

  /**
   * Send the ticks that wait, in their order. One the server refuses is
   * dropped: the list it was made on is gone, or the row is. When the server
   * cannot be reached again, that one and the ones after it go on waiting.
   */
  async replay(send: (tick: WaitingTick) => Promise<unknown>): Promise<Replayed> {
    const result: Replayed = { sent: 0, refused: 0, left: 0 };
    const ticks = waitingNow();
    for (const [index, tick] of ticks.entries()) {
      try {
        await send(tick);
        result.sent += 1;
      } catch (error) {
        if (error instanceof ApiClientError && error.code === 'NETWORK') {
          result.left = ticks.length - index;
          writeWaiting(ticks.slice(index));
          return result;
        }
        result.refused += 1;
      }
    }
    writeWaiting([]);
    return result;
  },
};
