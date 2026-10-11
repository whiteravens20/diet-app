// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveJsonFile } from './admin-api';

describe('saving a file the page already holds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hands the browser the content as JSON under the name given, and asks no server', async () => {
    const made: Blob[] = [];
    const clicked: { name: string; href: string }[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (made.push(blob), 'blob:a-file'), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    const asked = vi.spyOn(globalThis, 'fetch');

    saveJsonFile('bundle-2026-10-11.json', [{ slug: 'oat-bowl', title: { pl: 'Owsianka' } }]);

    expect(clicked).toEqual([{ name: 'bundle-2026-10-11.json', href: 'blob:a-file' }]);
    expect(made[0]!.type).toBe('application/json');
    expect(JSON.parse(await made[0]!.text())).toEqual([{ slug: 'oat-bowl', title: { pl: 'Owsianka' } }]);
    expect(await made[0]!.text()).toContain('\n  {');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a-file');
    // The link does not stay in the page.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });
});
