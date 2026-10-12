// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AiGenerationMeta } from '@diet-app/shared';
import messages from '../../messages/en.json';
import { ModelSays, WeighButton, WeighedLine } from './weigh';

const shown = (what: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={messages}>{what}</NextIntlClientProvider>);
const answered: AiGenerationMeta = { provider: 'ollama', model: 'test-model', failoverChain: [], usedDeterministicFallback: false, fallbackReason: null, reason: null };

describe('the button that asks a model to weigh what the engine proposed', () => {
  it('asks when it is pressed, and says what asking does', async () => {
    const onAsk = vi.fn();
    shown(<WeighButton enabled offNote={undefined} asking={false} onAsk={onAsk} />);

    const button = screen.getByRole('button', { name: messages.weigh.ask });
    expect(button).toHaveAttribute('title', messages.weigh.tooltip);
    await userEvent.click(button);

    expect(onAsk).toHaveBeenCalledOnce();
  });

  it('stays in its place on an account with no model to ask, disabled, and names the line that says why', () => {
    shown(
      <>
        <WeighButton enabled={false} offNote="why-off" asking={false} onAsk={() => undefined} />
        <p id="why-off">AI is turned off for this account.</p>
      </>,
    );

    const button = screen.getByRole('button', { name: messages.weigh.ask });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('AI is turned off for this account.');
  });

  it('says that it is asking while it is, and takes no second press', () => {
    shown(<WeighButton enabled offNote={undefined} asking onAsk={() => undefined} />);

    expect(screen.getByRole('button', { name: messages.weigh.asking })).toBeDisabled();
  });
});

describe('what is said of how asking a model went', () => {
  it('is nothing while no model was asked', () => {
    shown(<WeighedLine aiMeta={null} />);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('is that a model put the proposals in order, and whose the proposals are', () => {
    shown(<WeighedLine aiMeta={answered} />);

    expect(screen.getByRole('status')).toHaveTextContent(messages.weigh.weighed);
  });

  it.each(['no_provider', 'quota_exhausted', 'invalid_output', 'provider_timeout'] as const)('is why the engine\'s order stands, when the model was no help: %s', (fallbackReason) => {
    shown(<WeighedLine aiMeta={{ ...answered, usedDeterministicFallback: true, fallbackReason }} />);

    expect(screen.getByRole('status')).toHaveTextContent(messages.aiFallback[fallbackReason]);
  });
});

describe('a model\'s sentence on a proposal', () => {
  it('stands under the mark that a model said it', () => {
    shown(<ModelSays reason="Uses up the chicken." />);

    expect(screen.getByText(messages.aiMark.label)).toBeInTheDocument();
    expect(screen.getByText('A model says of this: “Uses up the chicken.”')).toBeInTheDocument();
  });

  it('is nothing where the model said none', () => {
    const { container } = shown(<ModelSays reason={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
