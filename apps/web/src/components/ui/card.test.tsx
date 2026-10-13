// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardContent, CardHeader, CardTitle } from './card';

describe('Card', () => {
  it('shows a titled panel: the title is a heading and the content follows it', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Shopping list</CardTitle>
        </CardHeader>
        <CardContent>Twelve things to buy</CardContent>
      </Card>,
    );

    const title = screen.getByRole('heading', { level: 3, name: 'Shopping list' });
    const content = screen.getByText('Twelve things to buy');
    expect(title.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is the element it is told to be: what a card is given reaches the page', () => {
    render(
      <Card role="region" aria-label="This week" data-plan="a-plan" id="week">
        Seven days
      </Card>,
    );

    const card = screen.getByRole('region', { name: 'This week' });
    expect(card).toHaveAttribute('id', 'week');
    expect(card).toHaveAttribute('data-plan', 'a-plan');
    expect(card).toHaveTextContent('Seven days');
  });

  it.each([
    ['the card', Card, 'bg-card'],
    ['its header', CardHeader, 'flex'],
    ['its title', CardTitle, 'font-semibold'],
    ['its content', CardContent, 'p-5'],
  ] as const)('keeps the look of %s and adds what a page asks for', (_name, Part, own) => {
    render(<Part className="mt-8">A part</Part>);

    expect(screen.getByText('A part')).toHaveClass(own, 'mt-8');
  });

  it('lets a page take a spacing of the card back: the page is asked last', () => {
    render(<CardContent className="p-0">Edge to edge</CardContent>);

    const content = screen.getByText('Edge to edge');
    expect(content).toHaveClass('p-0');
    expect(content).not.toHaveClass('p-5');
  });
});
