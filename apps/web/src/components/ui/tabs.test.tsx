// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs, type TabItem } from './tabs';

type Id = 'first' | 'second' | 'third';

const TABS: TabItem<Id>[] = [
  { id: 'first', title: 'First', content: () => <p>The first part</p> },
  {
    id: 'second',
    title: 'Second',
    mark: { shown: '7', said: '7 wait' },
    content: () => <input aria-label="Typed in the second part" />,
  },
  { id: 'third', title: 'Third', content: () => <p>The third part</p> },
];

function Shown({ tabs = TABS, start = 'first' }: { tabs?: TabItem<Id>[]; start?: Id }) {
  const [active, setActive] = useState<Id>(start);
  return <Tabs label="Parts" tabs={tabs} active={active} onSelect={setActive} />;
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name });

describe('Tabs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('name themselves, say which is chosen, and tie each tab to its part', () => {
    render(<Shown />);

    expect(screen.getByRole('tablist', { name: 'Parts' })).toBeInTheDocument();
    expect(tab('First')).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Second/)).toHaveAttribute('aria-selected', 'false');
    const part = screen.getByRole('tabpanel', { name: 'First' });
    expect(part).toHaveAttribute('id', tab('First').getAttribute('aria-controls'));
  });

  it('render a part when it is first opened, and keep it hidden after that with what was typed', async () => {
    render(<Shown />);
    expect(screen.queryByRole('textbox')).toBeNull();

    await userEvent.click(tab(/^Second/));
    await userEvent.type(screen.getByRole('textbox'), 'kept');
    await userEvent.click(tab('First'));

    expect(screen.getByText('The first part')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();

    await userEvent.click(tab(/^Second/));

    expect(screen.getByRole('textbox')).toHaveValue('kept');
    expect(screen.queryByText('The third part')).toBeNull();
  });

  it('say a mark to the eye and to a screen reader, each once', () => {
    render(<Shown />);

    expect(tab('Second, 7 wait')).toBeInTheDocument();
    expect(screen.getByText('7')).toHaveAttribute('aria-hidden', 'true');
  });

  it('move with the arrows and around the ends, and to the ends with Home and End', async () => {
    render(<Shown />);
    tab('First').focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(tab(/^Second/)).toHaveFocus();
    expect(tab(/^Second/)).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('First')).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('Third')).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(tab('First')).toHaveFocus();

    await userEvent.keyboard('{End}');
    expect(tab('Third')).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(tab('First')).toHaveFocus();
  });

  it('are one stop of the Tab key, and take no other key', async () => {
    render(<Shown />);
    expect(tab('First')).toHaveAttribute('tabindex', '0');
    expect(tab('Third')).toHaveAttribute('tabindex', '-1');
    tab('First').focus();

    await userEvent.keyboard('x');

    expect(tab('First')).toHaveFocus();
    expect(tab('First')).toHaveAttribute('aria-selected', 'true');
  });

  it('bring the chosen tab into view, where the row scrolls', async () => {
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    render(<Shown />);
    intoView.mockClear();

    await userEvent.click(tab('Third'));

    expect(intoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
  });

  it('let go of a tab that is taken away, and stand with none chosen', () => {
    const { rerender } = render(<Shown tabs={TABS} start="third" />);

    rerender(<Shown tabs={TABS.slice(0, 2)} start="third" />);

    expect(screen.queryByRole('tab', { name: 'Third' })).toBeNull();
    expect(screen.getAllByRole('tab').map((one) => one.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
    ]);
  });
});
