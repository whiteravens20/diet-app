// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolSection } from './tool-section';

const shown = (working: boolean) => (
  <ToolSection title="Write recipes" working={working}>
    <p>What the run did</p>
  </ToolSection>
);
const details = () => screen.getByRole('group');

describe('a tool of the curation queue', () => {
  it('is closed until it is wanted, opens for its work and stays open once the work is done', () => {
    const { rerender } = render(shown(false));
    expect(details()).not.toHaveAttribute('open');

    rerender(shown(true));
    expect(details()).toHaveAttribute('open');
    rerender(shown(false));
    expect(details()).toHaveAttribute('open');
  });

  it('opened by a click stays open through its work, and only a click closes it', async () => {
    const { rerender } = render(shown(false));
    await userEvent.click(screen.getByText('Write recipes'));
    expect(details()).toHaveAttribute('open');

    rerender(shown(true));
    rerender(shown(false));
    expect(details()).toHaveAttribute('open');
    await userEvent.click(screen.getByText('Write recipes'));
    expect(details()).not.toHaveAttribute('open');
  });
});
