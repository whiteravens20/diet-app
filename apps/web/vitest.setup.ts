// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// and runs DOM cleanup between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { IntlError } from 'next-intl';
import { afterEach } from 'vitest';

// A text the code asks for and the messages cannot give reaches the reader as its key, and
// next-intl only writes the error to the console: a test that renders one fails.
const broken: string[] = [];
const writeError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (args[0] instanceof IntlError) broken.push(args[0].message);
  writeError(...args);
};

afterEach(() => {
  cleanup();
  const found = broken.splice(0);
  if (found.length > 0) throw new Error(`a text the messages cannot give: ${found.join('; ')}`);
});

// The DOM the tests run in knows the dialog element but cannot open one. What a
// test needs of an open dialog is that its content is there; what the browser
// does with the focus and the page behind is tested in a browser.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

// The DOM the tests run in lays nothing out, and so has nowhere to scroll to.
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
window.scrollTo = (): void => {};
