// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { adminAccessOf } from './ai-quota.service.js';

describe("who may use the operator's provider", () => {
  const unconfirmed = { emailVerified: false, operatorAiApprovedAt: null };
  const confirmed = { emailVerified: true, operatorAiApprovedAt: null };
  const approved = { emailVerified: false, operatorAiApprovedAt: new Date() };

  it('is every account where the operator says everyone', () => {
    expect(
      [unconfirmed, confirmed, approved].map((account) => adminAccessOf('everyone', account)),
    ).toEqual(['granted', 'granted', 'granted']);
  });

  it('is an account with a confirmed address where the operator asks for one', () => {
    expect(
      [unconfirmed, confirmed, approved].map((account) => adminAccessOf('confirmed', account)),
    ).toEqual(['email_unconfirmed', 'granted', 'email_unconfirmed']);
  });

  it('is an account the operator approved where the operator approves each, whatever its address', () => {
    expect(
      [unconfirmed, confirmed, approved].map((account) => adminAccessOf('approved', account)),
    ).toEqual(['not_approved', 'not_approved', 'granted']);
  });
});
