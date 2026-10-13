// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('is a line of the width it is in until it is told otherwise', () => {
    const { container } = render(<Skeleton />);

    expect(container.firstElementChild).toHaveClass('skeleton', 'h-4', 'w-full');
  });

  it('takes the size of what it stands in for', () => {
    const { container } = render(<Skeleton className="h-24 w-40" />);

    const placeholder = container.firstElementChild!;
    expect(placeholder).toHaveClass('skeleton', 'h-24', 'w-40');
    expect(placeholder).not.toHaveClass('h-4');
    expect(placeholder).not.toHaveClass('w-full');
  });

  it('says nothing by itself, and can be kept from whoever does not see it', () => {
    const { container } = render(<Skeleton aria-hidden data-testid="waiting" />);

    const placeholder = container.firstElementChild!;
    expect(placeholder).toBeEmptyDOMElement();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder).toHaveAttribute('data-testid', 'waiting');
  });
});
