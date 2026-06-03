# AI model recommendations

Practical guidance for picking provider + model combinations that work for
this app's AI surfaces. The deterministic engine owns every quantitative
claim — the AI's job is structure, names, and prose. The hard requirements
are JSON-shape compliance, latency under the 60s per-provider deadline (see
[apps/api/src/ai/providers/ollama.provider.ts](../../apps/api/src/ai/providers/ollama.provider.ts)),
and reasonable Polish when a non-`en` locale is in scope.

The recommendations below are opinionated and grounded in the actual prompt
sizes and JSON shapes this codebase produces. They are not a survey of "good
models" — they are picks that fit *this* app.

---

## Surface vs. demand

Different AI surfaces stress the model differently. Pick the cheapest
provider/model that clears the demand bar for the surface you actually use.

| Surface | Endpoint / file | Input | Output | JSON strictness | Locale-keyed |
|---|---|---|---|---|---|
| **Recipe draft from prompt** | `POST /api/recipes/drafts/from-prompt` ([ai-recipe-draft.service.ts](../../apps/api/src/recipes/ai-recipe-draft.service.ts)) | ~2.5k tok (60-ingredient catalogue + rules) | ~1.5k tok per locale | strict, nested | yes |
| **Admin recipe batch** | `POST /api/admin/drafts/recipes/generate` ([recipe-generator.runner.ts](../../apps/api/src/admin/drafts/recipe-generator.runner.ts)) | ~3k tok (full catalogue) | ~1.5k tok per locale | strict, nested | yes |
| **AI meal swap** | `POST /api/meal-plans/ai-swap-meal` | ~1k tok (candidate pool) | ~100 tok (pick + reason) | lenient | no |
| **AI ingredient swap suggest** | `POST /api/meal-plans/swap-ingredient/ai-suggest` | ~800 tok | ~100 tok | lenient | no |
| **Swap-rewrite (Mode B)** | internal call from `applyIngredientSwap` | ~500 tok (sentences only) | ~500 tok | raw text | yes (per locale) |
| **Admin auto-translate** | `POST /api/admin/translations/fill` | per-row, ~200 tok | ~200 tok | strict (key-preserving) | yes |
| **Admin ingredient-name draft** | `POST /api/admin/drafts/ingredient-names/generate` ([ingredient-namer.runner.ts](../../apps/api/src/admin/drafts/ingredient-namer.runner.ts)) | per-row, ~150 tok | ~80 tok | strict | yes |

"Strict JSON" means: locale-keyed nested shape, every required key present,
every required locale populated, no markdown fences, no prose preamble. Small
or aggressively-quantised models fail this consistently; the
`AI_DRAFT_INVALID` toast traces back to this almost every time. The post-fix
WARN log in [ai-recipe-draft.service.ts:209](../../apps/api/src/recipes/ai-recipe-draft.service.ts#L209)
prints the model's raw response so you can diagnose without guessing.

---

## Recommendations by hardware tier

### Tier 1 — Cloud (recommended starting point)

**Pick a cloud provider for recipe drafting and admin batch generation
unless you have real GPU hardware on hand.** The strict-JSON + 2-locale
prompt is the single most demanding thing this app ever asks a model to do,
and the cost is small (drafting a recipe is one short request).

| Provider | Model | Why |
|---|---|---|
| **OpenRouter (free tier)** | `meta-llama/llama-3.3-70b-instruct:free` | Free, returns valid 2-locale JSON, Polish is usable. Best free option for self-hosters. |
| | `deepseek/deepseek-chat-v3.1:free` | Free, very strong at structured output, decent Polish. |
| | `mistralai/mistral-small-3.1-24b-instruct:free` | Free, faster than 70b, weaker Polish prose. |
| **OpenAI** | `gpt-4o-mini` | Cheap, near-instant, reliable JSON. Best default for paid drafting. |
| | `gpt-4o` | Higher-quality Polish, ~10× cost. Use for the admin recipe-batch generator if Tier 1's free models miss too often. |
| **Anthropic** | `claude-haiku-4-5` | Cheap, fast, excellent JSON discipline. |
| | `claude-sonnet-4-6` | Best Polish prose of any provider tested. Use sparingly for high-value batches. |

For **AI meal/ingredient swap** and **admin auto-translate**, the demand is
much lower — `gpt-4o-mini` or any free OpenRouter 8B+ model is fine.

OpenRouter free tier is rate-limited (~20 req/min, ~200/day per account).
That is plenty for personal use and small instances. The admin recipe batch
generator is the only surface that will plausibly run into it; switch to a
paid model for large batches.

### Tier 2 — Self-hosted Ollama on a real GPU

"Real" means **≥12 GB VRAM** so a 14B Q4 model fits entirely on the GPU.
Anything less and you are partial-offloading, which collapses to <5 tok/s
and trips the 60s per-provider deadline on the recipe-draft prompt.

| Class | Model | Fits in | Notes |
|---|---|---|---|
| **Recommended** | `qwen2.5:14b` or `qwen2.5:14b-instruct` | 9 GB VRAM | Excellent structured output, usable Polish, ~40 tok/s on a 3060 12 GB. |
| | `qwen2.5:7b-instruct` | 5 GB VRAM | Lower bar; works for swaps and translation, often misses the locale-keyed recipe JSON shape. |
| **Acceptable** | `llama3.1:8b` | 5 GB VRAM | Reliable, weaker Polish. Good fallback when Qwen is unavailable. |
| | `mistral-nemo:12b` | 7 GB VRAM | Strong Polish, slightly less disciplined JSON than Qwen. |
| **High-end** | `qwen2.5:32b` | 19 GB VRAM | Production-grade output; needs a 24 GB card (3090, 4090). |

Set the model on the BYOK provider config in **Settings → AI providers** or
via `AI_DEFAULT_MODEL` for admin-mode.

### Tier 3 — Self-hosted Ollama without a real GPU

Honest answer: this tier is **not viable for recipe drafting or the admin
recipe batch generator**. The combination of strict JSON and 2-locale output
needs a model that simply does not run fast enough on CPU/iGPU to clear the
60s deadline. Use cloud for those surfaces and reserve local Ollama for the
lighter ones.

| Surface | Viable model on CPU/iGPU | Notes |
|---|---|---|
| AI meal/ingredient swap | `llama3.2:3b`, `qwen2.5:3b` | Borderline; pick fixed candidates so the prompt is short. |
| Admin auto-translate | `qwen2.5:3b`, `gemma3:4b` | Per-row request is small; works but slow on CPU. |
| Admin ingredient-name draft | `qwen2.5:3b` | Per-row request is small. |
| **Recipe draft / recipe batch** | — none — | Use cloud. |

`gemma3:1b` and `gemma3:4b` are too dumb for the locale-keyed JSON shape
even when they're fast. Symptom: a string of `AI_DRAFT_INVALID` toasts with
WARN lines showing prose preambles or missing locale keys.

---

## Calibration notes from this codebase

- **Locale-keyed shape is non-negotiable.** The prompt asks for
  `{titles:{en,pl}, descriptions:{en,pl}, steps:{en:[],pl:[]}, ...}`. Models
  under ~7B reliably collapse this to a flat `{title, description, steps}`,
  which the parser rejects. The pre-fix path was a generic toast; the post-fix
  log shows you exactly what the model emitted.
- **Context windows ≥ 8k.** Ollama defaults to 4k for many models. Either
  pull a `-32k` variant or set `OLLAMA_NUM_CTX=8192` on the host. The recipe
  prompt is ~2.5k input + the model's reasoning + ~1.5k output per locale —
  4k is too tight.
- **JSON-mode helps, doesn't save.** OpenAI/Ollama support `response_format:
  json_object` / `format: 'json'` and this app uses both. It eliminates
  markdown fences and prose preambles but does not enforce the *shape*. A
  3B model in JSON mode will still drop the locale keys.
- **Polish prose quality follows model size.** 7B–13B Polish is "good enough
  with operator polish in /admin/curation"; ≥24B is "ships unedited". The
  reviewer interface ([Phase H](../../docs/adr/0008-curation-queue.md) when it
  lands) is the right surface for polishing low-end output rather than
  jumping to a bigger model.
- **Temperature.** Drafting paths run at `temperature: 0.7` for variety;
  translation runs at `0.2` for fidelity. Don't raise translation
  temperature — it produces "creative" mistranslations that pass the
  validator.

---

## How to switch

- **BYOK** (per-user): Settings → AI providers → edit the row. Test with
  the "Test connection" button before saving so the model list populates
  and you confirm the credential works.
- **Admin default** (operator-wide): set `AI_DEFAULT_PROVIDER` +
  `AI_DEFAULT_MODEL` (and the matching `*_API_KEY` or `OLLAMA_BASE_URL`)
  in `.env`, then restart the api + worker containers. See
  [env-reference.md](env-reference.md).

The router's failover means you can chain providers — e.g. a free
OpenRouter primary with local Ollama secondary. When the primary times out
or rate-limits, the request silently rolls to the next without bothering
the user.

---

## Quick-pick

If you don't want to read the table:

- **You self-host and have no GPU** → OpenRouter free tier with
  `meta-llama/llama-3.3-70b-instruct:free` as BYOK or admin default.
- **You have a 12 GB+ GPU** → local Ollama with `qwen2.5:14b`.
- **You want zero-friction paid** → OpenAI `gpt-4o-mini`.
- **You want the best Polish output** → Anthropic `claude-sonnet-4-6`.
