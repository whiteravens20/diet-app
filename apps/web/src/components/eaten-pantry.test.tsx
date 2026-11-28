// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EatenPantry } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { spaced } from '@/testing/spaces';
import messages from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { useEatenPantry } from './eaten-pantry';

const texts = messages.eatenPantry;
const PATH =
  '/meal-plans/11111111-1111-4111-8111-111111111111/meals/33333333-3333-4333-8333-333333333333';
const CHICKEN = '55555555-5555-4555-8555-555555555551';
const EGG = '55555555-5555-4555-8555-555555555552';
/** The other person's meal of a meal eaten by both. */
const OTHER =
  '/meal-plans/11111111-1111-4111-8111-111111111112/meals/33333333-3333-4333-8333-333333333334';

/** Of a lunch of chicken and two eggs, what taking it off a pantry of 400 g of chicken and six eggs would take. */
const OFFER: EatenPantry = {
  profileName: 'Paweł',
  offer: [
    {
      ingredientId: CHICKEN,
      name: 'Chicken breast',
      eaten: { quantity: 150, unit: 'g' },
      held: { quantity: 400, unit: 'g' },
      taken: { quantity: 150, unit: 'g' },
      borrowed: null,
    },
    {
      ingredientId: EGG,
      name: 'Egg',
      eaten: { quantity: 2, unit: 'piece', grams: 110 },
      held: { quantity: 6, unit: 'piece', grams: 330 },
      taken: { quantity: 2, unit: 'piece', grams: 110 },
      borrowed: null,
    },
  ],
  taken: [],
};
/** The same, once it was taken. */
const TAKEN: EatenPantry = {
  profileName: 'Paweł',
  offer: [],
  taken: OFFER.offer.map((line) => ({ ...line, held: { ...line.held, quantity: 0 } })),
};
const NOTHING: EatenPantry = { profileName: 'Paweł', offer: [], taken: [] };

/** A page with a meal or an entry at `PATH`, which asks what eating it does to the pantry as the page would. */
function Page({ remove }: { remove: () => void }) {
  const pantry = useEatenPantry();
  return (
    <>
      <button type="button" onClick={() => pantry.ask(PATH, 'take')}>
        eaten
      </button>
      <button type="button" onClick={() => pantry.ask(PATH, 'give-back')}>
        not eaten
      </button>
      <button type="button" onClick={() => pantry.ask(PATH, 'remove', remove)}>
        remove
      </button>
      <button type="button" onClick={() => pantry.ask([PATH, OTHER], 'take')}>
        eaten by both
      </button>
      {pantry.dialog}
    </>
  );
}

/** The page in `language`, the API answering the pantry of `PATH` with `answer` and a take or a giving back with `wrote`. */
function opened(
  answer: EatenPantry | Error,
  wrote: EatenPantry | Error = NOTHING,
  language: 'en' | 'pl' = 'en',
) {
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never),
    );
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation(() =>
      wrote instanceof Error ? Promise.reject(wrote) : Promise.resolve(wrote as never),
    );
  const remove = vi.fn();
  render(
    <NextIntlClientProvider locale={language} messages={language === 'en' ? messages : pl}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page remove={remove} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { get, post, remove };
}

const press = (name: string) => userEvent.click(screen.getByRole('button', { name }));
const theWindow = async (title: string) =>
  within(await screen.findByRole('dialog', { name: title }));

describe('what eating takes off the pantry, asked once a meal is eaten or an entry written', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names what it would take, what was eaten and what the pantry holds, and takes it only when told to', async () => {
    const { get, post } = opened(OFFER, TAKEN);

    await press('eaten');

    expect(get).toHaveBeenCalledWith(`${PATH}/pantry`);
    const window = await theWindow(texts.takeTitle);
    expect(window.getByText(texts.takeNote)).toBeInTheDocument();
    expect(window.getByText('Chicken breast')).toBeInTheDocument();
    expect(
      window.getByText(spaced('eaten 150 g · in the pantry 400 g · you take 150 g')),
    ).toBeInTheDocument();
    // What is counted, in its pieces, with what they weigh.
    expect(
      window.getByText(
        spaced(
          'eaten 2 pieces (110 g) · in the pantry 6 pieces (330 g) · you take 2 pieces (110 g)',
        ),
      ),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    // A long list scrolls on its own, and a keyboard reaches it before the buttons below it.
    expect(window.getByRole('group', { name: texts.foods })).toHaveAttribute('tabindex', '0');
    // One portion: no name over it.
    expect(window.queryByRole('heading', { name: 'Paweł' })).toBeNull();

    await userEvent.click(window.getByRole('button', { name: texts.take }));

    expect(post).toHaveBeenCalledWith(`${PATH}/pantry-take`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('takes nothing when it is not wanted now', async () => {
    const { post } = opened(OFFER);

    await press('eaten');
    await userEvent.click(
      (await theWindow(texts.takeTitle)).getByRole('button', { name: texts.notNow }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing is offered, as on a day a shopping list covers', NOTHING],
    ['it took already', TAKEN],
    ['the API cannot be asked', new Error('down')],
  ])('asks nothing where %s', async (_where, answer) => {
    const { get, post } = opened(answer);

    await press('eaten');

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('offers, once the mark is taken back, to give back what was taken, and gives it only when told to', async () => {
    const { post } = opened(TAKEN, NOTHING);

    await press('not eaten');
    const window = await theWindow(texts.giveBackTitle);
    expect(window.getByText(texts.giveBackNote)).toBeInTheDocument();
    expect(window.getByText(spaced('Chicken breast: 150 g'))).toBeInTheDocument();
    expect(window.getByText(spaced('Egg: 2 pieces (110 g)'))).toBeInTheDocument();
    await userEvent.click(window.getByRole('button', { name: texts.keep }));
    expect(post).not.toHaveBeenCalled();

    await press('not eaten');
    await userEvent.click(
      (await theWindow(texts.giveBackTitle)).getByRole('button', { name: texts.giveBack }),
    );

    expect(post).toHaveBeenCalledWith(`${PATH}/pantry-return`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks nothing once the mark is taken back where nothing was taken', async () => {
    opened(OFFER);

    await press('not eaten');

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers, before an entry that took food is removed, to give it back first, and removes it either way when told to', async () => {
    const { post, remove } = opened(TAKEN, NOTHING);

    await press('remove');
    const window = await theWindow(texts.removeTitle);
    expect(window.getByText(texts.removeNote)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(window.getByRole('button', { name: texts.giveBackAndRemove }));

    expect(post).toHaveBeenCalledWith(`${PATH}/pantry-return`);
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    // Given back first: the entry goes after the pantry has its food again.
    expect(post.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);

    post.mockClear();
    await press('remove');
    await userEvent.click(
      (await theWindow(texts.removeTitle)).getByRole('button', { name: texts.removeOnly }),
    );
    expect(remove).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();

    await press('remove');
    await userEvent.click(
      (await theWindow(texts.removeTitle)).getByRole('button', { name: messages.common.cancel }),
    );
    expect(remove).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing was taken', NOTHING],
    ['the API cannot be asked', new Error('down')],
  ])('removes an entry at once where %s', async (_where, answer) => {
    const { post, remove } = opened(answer);

    await press('remove');

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("asks of a meal eaten by both about each person's portion, from that person's pantry, and takes both on one press", async () => {
    const { get, post } = opened(OFFER, NOTHING);
    get.mockImplementation((path: string) =>
      Promise.resolve(
        (path === `${OTHER}/pantry`
          ? { ...OFFER, profileName: 'Ewa', offer: OFFER.offer.slice(0, 1) }
          : OFFER) as never,
      ),
    );

    await press('eaten by both');

    const window = await theWindow(texts.takeTitle);
    expect(window.getByText(texts.byPerson)).toBeInTheDocument();
    expect(window.getByRole('heading', { name: 'Paweł' })).toBeInTheDocument();
    expect(window.getByRole('heading', { name: 'Ewa' })).toBeInTheDocument();
    expect(window.getAllByText('Chicken breast')).toHaveLength(2);
    await userEvent.click(window.getByRole('button', { name: texts.take }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenCalledWith(`${PATH}/pantry-take`);
    expect(post).toHaveBeenCalledWith(`${OTHER}/pantry-take`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("asks about the portion it can read, where the other person's cannot be read", async () => {
    const { get } = opened(OFFER);
    get.mockImplementation((path: string) =>
      path === `${OTHER}/pantry`
        ? Promise.reject(new Error('down'))
        : Promise.resolve(OFFER as never),
    );

    await press('eaten by both');

    const window = await theWindow(texts.takeTitle);
    expect(window.queryByText(texts.byPerson)).toBeNull();
    expect(window.getAllByText('Chicken breast')).toHaveLength(1);
  });

  it('says why where taking fails, and keeps the window open', async () => {
    opened(OFFER, new ApiClientError(500, 'ERROR', 'down'));

    await press('eaten');
    const window = await theWindow(texts.takeTitle);
    await userEvent.click(window.getByRole('button', { name: texts.take }));

    expect(await window.findByRole('alert')).toHaveTextContent(texts.errTake);
    expect(screen.getByRole('dialog', { name: texts.takeTitle })).toBeInTheDocument();
  });

  it('says it in Polish', async () => {
    opened(OFFER, NOTHING, 'pl');

    await press('eaten');

    const window = await theWindow(pl.eatenPantry.takeTitle);
    expect(
      window.getByText(spaced('zjedzone 150 g · w spiżarni 400 g · zdejmiesz 150 g')),
    ).toBeInTheDocument();
    expect(
      window.getByText(
        spaced(
          'zjedzone 2 sztuki (110 g) · w spiżarni 6 sztuk (330 g) · zdejmiesz 2 sztuki (110 g)',
        ),
      ),
    ).toBeInTheDocument();
    expect(window.getByRole('button', { name: pl.eatenPantry.take })).toBeInTheDocument();
  });
});
