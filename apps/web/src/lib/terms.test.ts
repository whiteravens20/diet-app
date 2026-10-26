// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTerms, renderTerms, termsFor } from './terms';

const made: string[] = [];

/** A directory holding `files`, removed after the test. */
function directoryWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'terms-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the terms as HTML', () => {
  it('shows raw HTML as the text it is', () => {
    const { html } = renderTerms(
      'Before <script>alert(1)</script> after\n\n<img src=x onerror=alert(1)>',
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
  });

  it('keeps the text of a link whose address is not plainly a web or mail address or a path, and drops the address', () => {
    for (const href of [
      'javascript:alert(1)',
      'jav&#x61;script:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      'vbscript:x',
    ]) {
      const { html } = renderTerms(`[read this](${href})`);

      expect(html, href).toContain('read this');
      expect(html, href).not.toContain('<a');
    }
  });

  it('keeps web and mail addresses and the paths of the site', () => {
    const { html } = renderTerms(
      '[web](https://example.org/terms) [mail](mailto:operator@example.org) [page](/settings) [part](#section-2)',
    );

    expect(html).toContain('href="https://example.org/terms"');
    expect(html).toContain('href="mailto:operator@example.org"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="#section-2"');
  });

  it('shows a picture with an address it does not keep as its description', () => {
    const { html } = renderTerms('![Our logo](data:image/png;base64,AAAA)');

    expect(html).toContain('Our logo');
    expect(html).not.toContain('<img');
  });

  it('gives each second-level heading an id in order, and lists them as plain text', () => {
    const { html, outline } = renderTerms(
      '# Terms\n\n## 1. **Accounts**\n\nText.\n\n### A detail\n\n## 2. Data',
    );

    expect(outline).toEqual([
      { id: 'section-1', title: '1. Accounts' },
      { id: 'section-2', title: '2. Data' },
    ]);
    expect(html).toContain('<h2 id="section-1">1. <strong>Accounts</strong></h2>');
    expect(html).toContain('<h1>Terms</h1>');
    expect(html).toContain('<h3>A detail</h3>');
  });
});

describe('the files of the terms', () => {
  it('are none where there is no TOS.md, or no directory at all', () => {
    expect(readTerms(directoryWith({ 'TOS.pl.md': '# Regulamin' }))).toBeNull();
    expect(readTerms(path.join(tmpdir(), 'no-such-terms-directory'))).toBeNull();
  });

  it('are TOS.md with the translations named by a language code, and nothing else beside them', () => {
    const dir = directoryWith({
      'TOS.md': '# Terms',
      'TOS.pl.md': '# Regulamin',
      'TOS.pl-PL.md': '# Not a translation',
      'TOS.md.bak': '# An old copy',
      'notes.md': '# Notes',
    });
    // Docker puts a directory where a file it was told to mount is missing.
    mkdirSync(path.join(dir, 'TOS.de.md'));

    const terms = readTerms(dir);

    expect(terms?.terms.html).toContain('<h1>Terms</h1>');
    expect(Object.keys(terms?.translations ?? {})).toEqual(['pl']);
    expect(terms?.translations.pl.html).toContain('<h1>Regulamin</h1>');
  });
});

describe('the template that comes with the application', () => {
  const template = readTerms(path.resolve(process.cwd(), '..', '..', 'terms'));

  it('is in English and in Polish, with the same sections', () => {
    expect(template).not.toBeNull();
    expect(Object.keys(template?.translations ?? {})).toEqual(['pl']);
    expect(template?.terms.outline).toHaveLength(10);
    expect(template?.translations.pl.outline).toHaveLength(10);
  });

  it('says in both languages that it is a template, and names the check Cloudflare runs', () => {
    expect(template?.terms.html).toContain('This is a template, not the terms of this instance.');
    expect(template?.translations.pl.html).toContain('To szablon, a nie regulamin tej instancji.');
    expect(template?.terms.html).toContain('Cloudflare Turnstile');
    expect(template?.translations.pl.html).toContain('Cloudflare Turnstile');
  });

  it('is what an instance shows whose operator wrote none, in the language of the page or else in English, said once in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(termsFor('pl').html).toContain('<h1>Regulamin</h1>');
    expect(termsFor('en').html).toContain('<h1>Terms of Service</h1>');
    expect(termsFor('de').html).toContain('<h1>Terms of Service</h1>');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
