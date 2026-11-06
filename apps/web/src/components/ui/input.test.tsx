// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field, Input } from './input';

describe('Input', () => {
  it('takes what is typed into it and tells whoever asked', async () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" onChange={onChange} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('is the input it is told to be', () => {
    render(
      <Input
        aria-label="Weight"
        type="number"
        min={30}
        max={400}
        step="0.1"
        inputMode="decimal"
        placeholder="80"
        required
      />,
    );

    const input = screen.getByRole('spinbutton', { name: 'Weight' });
    expect(input).toHaveAttribute('min', '30');
    expect(input).toHaveAttribute('max', '400');
    expect(input).toHaveAttribute('step', '0.1');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveAttribute('placeholder', '80');
    expect(input).toBeRequired();
  });

  it('takes nothing while it is switched off', async () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" disabled onChange={onChange} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hands the element to whoever holds a reference to it', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input aria-label="Search" ref={ref} />);

    ref.current!.focus();

    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
  });

  it('keeps its look and adds what a page asks for', () => {
    render(<Input aria-label="Code" className="h-12 text-center" />);

    const input = screen.getByRole('textbox', { name: 'Code' });
    expect(input).toHaveClass('rounded-md', 'h-12', 'text-center');
    expect(input).not.toHaveClass('h-10');
  });
});

describe('Field', () => {
  it('names the input inside it: a click on the label goes to the input', async () => {
    render(
      <Field label="E-mail">
        <Input type="email" />
      </Field>,
    );

    await userEvent.click(screen.getByText('E-mail'));

    expect(screen.getByLabelText('E-mail')).toHaveFocus();
  });

  it('shows a hint under the input when it has one', () => {
    render(
      <Field label="Password" hint="Twelve characters or more">
        <Input type="password" />
      </Field>,
    );

    const hint = screen.getByText('Twelve characters or more');
    expect(
      screen.getByLabelText(/Password/).compareDocumentPosition(hint) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says what is wrong with what it holds, as soon as somebody may read it', () => {
    render(
      <Field label="Code" error="Not a code.">
        <Input />
      </Field>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Not a code.');
    expect(screen.getByRole('textbox', { name: /Code/ })).toBeInTheDocument();
  });

  it('shows no empty line where there is no hint', () => {
    const { container } = render(
      <Field label="Name">
        <Input />
      </Field>,
    );

    expect(container.querySelectorAll('label > span')).toHaveLength(1);
  });
});

describe('Field', () => {
  it('says in the top edge of its frame that it may stay empty, and nothing where it may not', () => {
    render(
      <NextIntlClientProvider locale="pl" messages={{ common: { optional: 'opcjonalnie' } }}>
        <Field label="Waga docelowa" optional>
          <Input aria-label="Waga docelowa" />
        </Field>
        <Field label="Imię">
          <Input aria-label="Imię" />
        </Field>
      </NextIntlClientProvider>,
    );

    const frame = screen.getByRole('textbox', { name: 'Waga docelowa' }).parentElement;
    expect(frame).toHaveAttribute('data-optional', 'opcjonalnie');
    expect(frame?.className).toContain('after:content-[attr(data-optional)]');
    expect(screen.getByRole('textbox', { name: 'Imię' }).closest('[data-optional]')).toBeNull();
  });
});
