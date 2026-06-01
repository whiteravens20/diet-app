/**
 * Shared AI helpers used by the draft pipelines: per-provider tuning knobs
 * + a JSON extractor that strips markdown fences and leading prose from raw
 * model output.
 */

/** Per-provider temperature / batch-size tuning. Drafts use only
 *  `temperature` from this table; `batchSize` and `interBatchDelayMs` are
 *  here because the runners share the constant with future batching work. */
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

/** Strip a leading markdown fence and any prose preceding the first `{`. */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
