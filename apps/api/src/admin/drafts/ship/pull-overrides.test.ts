import { describe, expect, it } from 'vitest';
import { resolvePullSource, PullOverridesError } from './pull-overrides.js';

describe('resolvePullSource', () => {
  it('resolves owner/repo to the GitHub contents API on the default branch', () => {
    const r = resolvePullSource('whiteravens20/diet-app');
    expect(r.github).toBe(true);
    expect(r.api).toBe(true);
    expect(r.url).toBe(
      'https://api.github.com/repos/whiteravens20/diet-app/contents/data/ingredient-overrides.json?ref=main',
    );
  });

  it('honours an explicit @branch', () => {
    const r = resolvePullSource('me/fork@dev');
    expect(r.url).toContain('/repos/me/fork/contents/data/ingredient-overrides.json?ref=dev');
  });

  it('passes a full GitHub raw URL through and flags it as github', () => {
    const r = resolvePullSource(
      'https://raw.githubusercontent.com/me/fork/main/data/ingredient-overrides.json',
    );
    expect(r.api).toBe(false);
    expect(r.github).toBe(true);
    expect(r.url).toContain('raw.githubusercontent.com');
  });

  it('treats a non-GitHub URL as non-github (no token attached)', () => {
    const r = resolvePullSource('https://gitea.example.com/me/fork/raw/branch/main/x.json');
    expect(r.github).toBe(false);
    expect(r.api).toBe(false);
  });

  it('rejects garbage that is neither a repo nor a URL', () => {
    expect(() => resolvePullSource('not a repo!!')).toThrow(PullOverridesError);
  });
});
