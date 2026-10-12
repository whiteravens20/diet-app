// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

describe('putting a text on the clipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says that it is there when the browser took it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    expect(await copyText('rice')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('rice');
  });

  it('says that it is not, without failing, on a page the browser gives no clipboard', async () => {
    vi.stubGlobal('navigator', {});

    expect(await copyText('rice')).toBe(false);
  });

  it('says that it is not when the browser refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('not allowed')) } });

    expect(await copyText('rice')).toBe(false);
  });
});
