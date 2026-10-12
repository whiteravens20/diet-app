// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// and runs DOM cleanup between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
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
