// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';

/**
 * What a browser sends to `POST /csp-reports` when a page of the web
 * application broke its content security policy. No client of the API writes
 * one: a browser does, by itself, in one of two shapes. Only the fields the
 * API reads are named; a browser sends more, and that is dropped.
 */

/** No address and no directive is longer than this. */
const text = z.string().max(4096);
const position = z.number().int().min(0).max(100_000_000);

/** The most reports one request may carry. A browser sends the ones it had waiting together. */
export const MAX_POLICY_REPORTS_PER_REQUEST = 100;

/** The shape `report-uri` asks for (`application/csp-report`). */
export const PostedPolicyReport = z.object({
  'csp-report': z.object({
    'document-uri': text.optional(),
    'effective-directive': text.optional(),
    'violated-directive': text.optional(),
    'blocked-uri': text.optional(),
    'source-file': text.optional(),
    'line-number': position.optional(),
    'column-number': position.optional(),
    disposition: text.optional(),
  }),
});
export type PostedPolicyReport = z.infer<typeof PostedPolicyReport>;

/** The shape `report-to` asks for (`application/reports+json`): reports of every kind, those about the policy with the type `csp-violation`. */
export const QueuedPolicyReports = z
  .array(
    z.object({
      type: text,
      body: z
        .object({
          documentURL: text.optional(),
          effectiveDirective: text.optional(),
          blockedURL: text.optional(),
          sourceFile: text.optional(),
          lineNumber: position.optional(),
          columnNumber: position.optional(),
          disposition: text.optional(),
        })
        .optional(),
    }),
  )
  .max(MAX_POLICY_REPORTS_PER_REQUEST);
export type QueuedPolicyReports = z.infer<typeof QueuedPolicyReports>;

export const PolicyReport = z.union([PostedPolicyReport, QueuedPolicyReports]);
export type PolicyReport = z.infer<typeof PolicyReport>;
