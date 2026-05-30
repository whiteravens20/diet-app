/**
 * Tests the canonical-remote guard from ADR-0008. The self-hoster foot-gun
 * is "I left `origin` pointing at whiteravens20/diet-app and flipped
 * SHIP_UPSTREAM_ENABLED on" — the runner has to refuse that loudly while
 * still allowing forks and private mirrors.
 */
import { describe, expect, it } from 'vitest';
import { isCanonicalRemoteUrl } from './upstream-mode.js';

describe('isCanonicalRemoteUrl', () => {
  it.each([
    'https://github.com/whiteravens20/diet-app',
    'https://github.com/whiteravens20/diet-app.git',
    'git@github.com:whiteravens20/diet-app.git',
    'git@github.com:whiteravens20/diet-app',
    'ssh://git@github.com/whiteravens20/diet-app.git',
    'https://github.com/WHITERAVENS20/diet-app.git', // case-insensitive
  ])('rejects canonical remote URL %s', (url) => {
    expect(isCanonicalRemoteUrl(url)).toBe(true);
  });

  it.each([
    'https://github.com/pavlojs/diet-app',
    'git@github.com:pavlojs/diet-app.git',
    'https://gitea.local/me/diet-content.git',
    'https://github.com/whiteravens20/something-else',
    'https://github.com/notwhiteravens20/diet-app', // boundary
    'https://github.com/whiteravens20/diet-app-fork',
    'file:///home/op/my-private-content',
  ])('accepts non-canonical remote URL %s', (url) => {
    expect(isCanonicalRemoteUrl(url)).toBe(false);
  });
});
