// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedProduct, ProductUnderReview } from '@diet-app/shared';
import { adminApi, type AdminProducts } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { productImportNeedsAttention, ProductsCard } from './products-card';
import { plain } from '@/testing/spaces';

const t = en.admin.products;

const IMPORTED: AdminProducts = {
  lookups: true,
  countries: ['poland', 'germany'],
  held: { imported: 263587, lookedUp: 12, accepted: 4, waiting: 0, unknownCodes: 3 },
  lookupsToday: 7,
  import: {
    status: 'done',
    startedAt: '2026-11-02T02:00:00.000Z',
    finishedAt: '2026-11-02T02:02:00.000Z',
    error: null,
    reason: null,
    countries: ['poland', 'germany'],
    perCountry: { poland: 24690, germany: 239926 },
    read: 4887731,
    leftOut: { code: 7520, name: 25307, figures: 179232 },
    added: 263587,
    changed: 0,
    removed: 0,
  },
  askedAt: null,
  askAgainAt: null,
};

const failed = (reason: AdminProducts['import']['reason'], error = 'Detail.'): AdminProducts => ({
  ...IMPORTED,
  import: { ...IMPORTED.import, status: 'error', reason, error },
});

const FIGURES = {
  calories: 245,
  protein: 8,
  fat: 3,
  carbs: 45,
  fiber: null,
  sugars: null,
  salt: null,
  saturatedFat: null,
};

const WAITING: ProductUnderReview = {
  id: '99999999-9999-4999-8999-999999999999',
  code: '5900512320359',
  name: 'Waiting bread',
  brand: null,
  pack: null,
  unit: 'g',
  packAmount: null,
  servingAmount: null,
  per100: FIGURES,
  energyWorkedOut: false,
  doubtful: false,
  changedAt: null,
  sentAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
};

const ACCEPTED: AcceptedProduct = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  code: '5900512320366',
  name: 'Accepted bread',
  brand: 'Babcia',
  pack: null,
  unit: 'g',
  packAmount: null,
  servingAmount: null,
  per100: FIGURES,
  energyWorkedOut: false,
  doubtful: false,
  changedAt: null,
  acceptedAt: '2026-11-02T11:00:00.000Z',
  acceptedBy: 'Anna',
  hasAuthor: true,
};

function shown(products: AdminProducts | null, messages: typeof en = en, locale = 'en') {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <ProductsCard products={products} onChanged={onChanged} />
    </NextIntlClientProvider>,
  );
  return { onChanged };
}

describe('the card of products in the panel', () => {
  beforeEach(() => {
    vi.spyOn(adminApi, 'productQueue').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(adminApi, 'acceptedProducts').mockResolvedValue({
      items: [],
      page: 1,
      totalPages: 0,
      total: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('says how products reach the instance, and what it holds', () => {
    shown(IMPORTED);
    expect(
      screen.getByText(/Checking single codes: on, 7 in the last 24 hours/),
    ).toBeInTheDocument();
    expect(screen.getByText('Countries of the import: poland, germany.')).toBeInTheDocument();
    expect(
      screen.getByText(
        /From the import: 263587\. From single codes: 12\. Accepted from people: 4\. Codes remembered as unknown: 3\./,
      ),
    ).toBeInTheDocument();
  });

  it('says how the last import went, country by country, with what it left out', () => {
    shown(IMPORTED);
    expect(
      screen.getByText(/Added 263587, changed 0, removed 0, of 4887731 rows/),
    ).toBeInTheDocument();
    expect(screen.getByText('poland: 24690')).toBeInTheDocument();
    expect(screen.getByText('germany: 239926')).toBeInTheDocument();
    expect(
      screen.getByText(/without a valid code 7520, without a name 25307, without figures 179232/),
    ).toBeInTheDocument();
  });

  it('points at a country that brought nothing, which is probably misspelt', () => {
    shown({
      ...IMPORTED,
      countries: ['poland', 'czechia'],
      import: { ...IMPORTED.import, perCountry: { poland: 24690, czechia: 0 } },
    });
    expect(
      screen.getByText(
        'czechia brought no product. Write it as in the address of its page: world.openfoodfacts.org/country/czechia.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/poland brought no product/)).not.toBeInTheDocument();
  });

  it('says that nothing is imported where no country is named, and offers no run', () => {
    shown({
      ...IMPORTED,
      countries: [],
      import: { ...IMPORTED.import, status: 'idle', startedAt: null, finishedAt: null },
    });
    expect(screen.getByText(t.noCountries)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.ask })).not.toBeInTheDocument();
  });

  it('says that lookups are off', () => {
    shown({ ...IMPORTED, lookups: false });
    expect(screen.getByText(t.lookupsOff)).toBeInTheDocument();
  });

  it('says that no import has run yet', () => {
    shown({
      ...IMPORTED,
      import: { ...IMPORTED.import, status: 'idle', startedAt: null, finishedAt: null },
    });
    expect(screen.getByText(t.never)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.ask })).toBeEnabled();
  });

  it.each([
    ['source', t.failedSource],
    ['format', t.failedFormat],
    ['nothing', t.failedNothing],
    ['shrunk', t.failedShrunk],
  ] as const)('says what to do about a run that failed for %s', (reason, said) => {
    shown(failed(reason));
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.getByText(/failed, and the products stayed as they were/)).toBeInTheDocument();
  });

  it('gives the words of a failure it has no reason for', () => {
    shown(failed(null, 'The run stopped with the process that ran it.'));
    expect(
      screen.getByText(/What went wrong: The run stopped with the process/),
    ).toBeInTheDocument();
  });

  it('takes a failed import as something to look at, and no other state', () => {
    expect(productImportNeedsAttention(failed('source'))).toBe(true);
    expect(productImportNeedsAttention(IMPORTED)).toBe(false);
    expect(productImportNeedsAttention(null)).toBe(false);
  });

  describe('asks for a run', () => {
    it('and says that the worker begins within a minute', async () => {
      const asked = { ...IMPORTED, askedAt: '2026-11-02T12:00:00.000Z' };
      const ask = vi.spyOn(adminApi, 'askForProductImport').mockResolvedValue(undefined);
      vi.spyOn(adminApi, 'products').mockResolvedValue(asked);
      const { onChanged } = shown(IMPORTED);
      await userEvent.click(screen.getByRole('button', { name: t.ask }));
      expect(ask).toHaveBeenCalledOnce();
      expect(onChanged).toHaveBeenCalledWith(asked);
    });

    it('not while one is asked for already', () => {
      shown({ ...IMPORTED, askedAt: '2026-11-02T12:00:00.000Z' });
      expect(screen.getByRole('button', { name: t.ask })).toBeDisabled();
      expect(screen.getByText(t.asked)).toBeInTheDocument();
    });

    it('not while one goes on, and says how far it is', () => {
      shown({ ...IMPORTED, import: { ...IMPORTED.import, status: 'running', read: 1200 } });
      expect(screen.getByRole('button', { name: t.ask })).toBeDisabled();
      expect(screen.getByText(/rows of the export read/)).toHaveTextContent('1200');
    });

    it("not within a day of the last, and says when, as the button's reason", () => {
      shown({ ...IMPORTED, askAgainAt: '2026-11-03T02:00:00.000Z' });
      const button = screen.getByRole('button', { name: t.ask });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/It can be asked for again/);
    });

    it('and says what a refusal is', async () => {
      vi.spyOn(adminApi, 'askForProductImport').mockRejectedValue(
        new ApiClientError(409, 'PRODUCT_IMPORT_TOO_SOON', 'Too soon.'),
      );
      shown(IMPORTED);
      await userEvent.click(screen.getByRole('button', { name: t.ask }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        plain(en.errors.PRODUCT_IMPORT_TOO_SOON),
      );
    });

    it('and follows the state while the worker is at it', () => {
      vi.useFakeTimers();
      const read = vi.spyOn(adminApi, 'products').mockResolvedValue({ ...IMPORTED, askedAt: null });
      shown({ ...IMPORTED, askedAt: '2026-11-02T12:00:00.000Z' });
      vi.advanceTimersByTime(5_000);
      expect(read).toHaveBeenCalledOnce();
    });
  });

  it('reads nothing by itself while nothing goes on', () => {
    vi.useFakeTimers();
    const read = vi.spyOn(adminApi, 'products');
    shown(IMPORTED);
    vi.advanceTimersByTime(60_000);
    expect(read).not.toHaveBeenCalled();
  });

  it('waits for what it shows', () => {
    shown(null);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.ask })).not.toBeInTheDocument();
  });

  it('speaks Polish in Polish, with numbers as the application writes them', () => {
    shown(IMPORTED, pl as unknown as typeof en, 'pl');
    expect(screen.getByText(pl.admin.products.title)).toBeInTheDocument();
    expect(screen.getByText(/Z importu: 263587/)).toBeInTheDocument();
  });

  describe('what people sent to the base', () => {
    it('says nothing is waiting or accepted while nothing is', async () => {
      shown(IMPORTED);

      expect(await screen.findByText(en.productReview.nothing)).toBeInTheDocument();
      expect(await screen.findByText(t.acceptedNone)).toBeInTheDocument();
    });

    it('needs attention while a product waits for a word', () => {
      expect(
        productImportNeedsAttention({ ...IMPORTED, held: { ...IMPORTED.held, waiting: 1 } }),
      ).toBe(true);
      expect(productImportNeedsAttention(IMPORTED)).toBe(false);
    });

    it('takes a word on a waiting product and reads the card again', async () => {
      vi.spyOn(adminApi, 'productQueue').mockResolvedValue({ items: [WAITING], total: 1 });
      const accept = vi.spyOn(adminApi, 'acceptProduct').mockResolvedValue(undefined);
      const read = vi.spyOn(adminApi, 'products').mockResolvedValue(IMPORTED);
      const { onChanged } = shown(IMPORTED);

      await userEvent.click(await screen.findByRole('button', { name: en.productReview.accept }));

      expect(accept).toHaveBeenCalledWith(WAITING.id, WAITING.updatedAt);
      await waitFor(() => expect(onChanged).toHaveBeenCalledWith(IMPORTED));
      expect(read).toHaveBeenCalled();
    });

    it('lists at once what was accepted from the queue above it', async () => {
      vi.spyOn(adminApi, 'productQueue').mockResolvedValue({ items: [WAITING], total: 1 });
      vi.spyOn(adminApi, 'acceptProduct').mockResolvedValue(undefined);
      vi.spyOn(adminApi, 'products').mockResolvedValue(IMPORTED);
      const list = vi.spyOn(adminApi, 'acceptedProducts');
      shown(IMPORTED);

      const accept = await screen.findByRole('button', { name: en.productReview.accept });
      await screen.findByText(t.acceptedNone);
      list.mockResolvedValue({ items: [ACCEPTED], page: 1, totalPages: 1, total: 1 });
      await userEvent.click(accept);

      expect(await screen.findByText(ACCEPTED.name)).toBeInTheDocument();
    });

    it('turns a waiting product down with its reason', async () => {
      vi.spyOn(adminApi, 'productQueue').mockResolvedValue({ items: [WAITING], total: 1 });
      const reject = vi.spyOn(adminApi, 'rejectProduct').mockResolvedValue(undefined);
      vi.spyOn(adminApi, 'products').mockResolvedValue(IMPORTED);
      shown(IMPORTED);

      await userEvent.click(await screen.findByRole('button', { name: en.productReview.reject }));
      await userEvent.type(
        screen.getByRole('textbox', { name: en.productReview.reason }),
        'Not on the label.',
      );
      await userEvent.click(screen.getByRole('button', { name: en.productReview.rejectConfirm }));

      expect(reject).toHaveBeenCalledWith(WAITING.id, WAITING.updatedAt, 'Not on the label.');
    });

    it('says who accepted a product and when, and whether its author is still there', async () => {
      vi.spyOn(adminApi, 'acceptedProducts').mockResolvedValue({
        items: [
          ACCEPTED,
          {
            ...ACCEPTED,
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            acceptedBy: null,
            hasAuthor: false,
          },
        ],
        page: 1,
        totalPages: 1,
        total: 2,
      });
      shown(IMPORTED);

      expect(await screen.findByText(/by Anna\.$/)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(t.acceptedNoAuthor))).toBeInTheDocument();
      // A product restored from the files names nobody.
      expect(screen.getByText(/^Accepted [^.]*\.\s*Its author/)).toBeInTheDocument();
    });

    it('withdraws an accepted product only with what its author is told', async () => {
      const list = vi.spyOn(adminApi, 'acceptedProducts').mockResolvedValue({
        items: [ACCEPTED],
        page: 1,
        totalPages: 1,
        total: 1,
      });
      const withdraw = vi.spyOn(adminApi, 'withdrawProduct').mockResolvedValue(undefined);
      vi.spyOn(adminApi, 'products').mockResolvedValue(IMPORTED);
      const { onChanged } = shown(IMPORTED);

      await userEvent.click(await screen.findByRole('button', { name: t.withdraw }));
      await userEvent.click(screen.getByRole('button', { name: t.withdrawConfirm }));
      expect(withdraw).not.toHaveBeenCalled();

      await userEvent.type(
        screen.getByRole('textbox', { name: (said) => said.startsWith(t.withdrawReason) }),
        ' Wrong figures. ',
      );
      await userEvent.click(screen.getByRole('button', { name: t.withdrawConfirm }));

      expect(withdraw).toHaveBeenCalledWith(ACCEPTED.id, 'Wrong figures.');
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(onChanged).toHaveBeenCalled();
    });

    it('says why a withdrawal did not stand', async () => {
      vi.spyOn(adminApi, 'acceptedProducts').mockResolvedValue({
        items: [ACCEPTED],
        page: 1,
        totalPages: 1,
        total: 1,
      });
      vi.spyOn(adminApi, 'withdrawProduct').mockRejectedValue(
        new ApiClientError(404, 'PRODUCT_NOT_FOUND', 'Gone.'),
      );
      shown(IMPORTED);

      await userEvent.click(await screen.findByRole('button', { name: t.withdraw }));
      await userEvent.type(
        screen.getByRole('textbox', { name: (said) => said.startsWith(t.withdrawReason) }),
        'Wrong.',
      );
      await userEvent.click(screen.getByRole('button', { name: t.withdrawConfirm }));

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });

    it('goes through a long list a page at a time', async () => {
      const list = vi.spyOn(adminApi, 'acceptedProducts').mockImplementation(async (page) => ({
        items: [{ ...ACCEPTED, name: `Bread of page ${page}` }],
        page,
        totalPages: 2,
        total: 2,
      }));
      shown(IMPORTED);

      expect(await screen.findByText('Bread of page 1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t.prev })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: t.next }));

      expect(await screen.findByText('Bread of page 2')).toBeInTheDocument();
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t.next })).toBeDisabled();
      expect(list).toHaveBeenLastCalledWith(2);
    });
  });
});
