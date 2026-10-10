// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Per-provider tuning of the admin draft runs: how freely the model writes,
 * how many ingredient names go into one call at most, and how long to pause
 * between calls where the provider limits the request rate.
 */
export const PROVIDER_TUNING: Record<
  'openai' | 'anthropic' | 'openrouter' | 'ollama',
  { temperature: number; batchSize: number; interBatchDelayMs: number }
> = {
  openai: { temperature: 0.2, batchSize: 50, interBatchDelayMs: 0 },
  anthropic: { temperature: 0.2, batchSize: 50, interBatchDelayMs: 0 },
  // batchSize=20: gemini-2.5-flash-lite (and similar) reliably truncate
  // JSON output around 10-12k chars regardless of max_tokens. 50 keys ×
  // 2 fields blew past that on PL recipes; 20 keys × 2 fields stays
  // comfortably below.
  openrouter: { temperature: 0.2, batchSize: 20, interBatchDelayMs: 3500 },
  ollama: { temperature: 0.2, batchSize: 20, interBatchDelayMs: 0 },
};

