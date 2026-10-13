# AI model recommendations

Practical guidance for picking provider + model combinations that work for
this app's AI surfaces. The deterministic engine owns every quantitative
claim — the AI's job is structure, names, and prose. The hard requirements
are JSON-shape compliance, an answer inside the wait of the request (see
[Limits on every request](#limits-on-every-request)), and reasonable Polish
when a non-`en` locale is in scope.

The recommendations below are opinionated and grounded in the actual prompt
sizes and JSON shapes this codebase produces. They are not a survey of "good
models" — they are picks that fit *this* app.

---

## Surface vs. demand

Different AI surfaces stress the model differently. Pick the cheapest
provider/model that clears the demand bar for the surface you actually use.

| Surface | Endpoint / file | Input | Output | JSON strictness | Locale-keyed |
|---|---|---|---|---|---|
| **Recipe draft from prompt** | `POST /api/recipes/drafts/from-prompt` ([ai-recipe-draft.service.ts](../../apps/api/src/recipes/ai-recipe-draft.service.ts)) | ~2.5k tok (up to 60 ingredients, named by slug, + rules) | ~1.5k tok per locale | strict, nested | yes |
| **Admin recipe batch** | `POST /api/admin/drafts/recipes/generate` ([recipe-generator.runner.ts](../../apps/api/src/admin/drafts/recipe-generator.runner.ts)) | ~9k tok a call (the rules, six examples, the curated catalogue with its names in each language) | ~1.5k tok per locale | strict, nested | yes |
| **AI meal swap** | `POST /api/meal-plans/ai-swap-meal` | ~1k tok (candidate pool) | ~100 tok (pick + reason) | lenient | no |
| **AI ingredient swap suggest** | `POST /api/meal-plans/swap-ingredient/ai-suggest` | ~800 tok | ~100 tok | lenient | no |
| **Swap rewrite** | `POST /api/meal-plans/swap-ingredient/apply` with `rewriteWithAi: true`, only when the user ticks it | ~500 tok (sentences only) | ~500 tok | strict (two keys) | no: one call, in the user's language |
| **Weighing what the planner proposes** | `POST /api/meal-plans/:id/days/:dayId/variations`, `POST /api/meal-plans/:id/use-up` and `POST /api/shopping-lists/:id/proposals`, each with `weigh: true`, only when the user asks ([weigh.service.ts](../../apps/api/src/ai/weigh.service.ts)) | ~300–700 tok (up to eight options, a line each) | ~200 tok (an order, and a sentence for each option) | lenient | no: one call, in the user's language |
| **Admin missing language** | `POST /api/admin/drafts/translations/generate` ([translation.runner.ts](../../apps/api/src/admin/drafts/translation.runner.ts)) | one recipe a call, ~600 tok (the title, the description and the steps, with two examples) | ~300 tok | strict (three keys, as many steps as it was given) | no: one call, one language |
| **Admin ingredient-name draft** | `POST /api/admin/drafts/ingredient-names/generate` ([ingredient-namer.runner.ts](../../apps/api/src/admin/drafts/ingredient-namer.runner.ts)) | per-row, ~150 tok | ~80 tok | strict | yes |

"Strict JSON" means: locale-keyed nested shape, every required key present,
every required locale populated, no markdown fences, no prose preamble. Small
or aggressively-quantised models fail this consistently; the
`AI_DRAFT_INVALID` toast traces back to this almost every time. The API then
logs a warning that begins with `AI_DRAFT_INVALID`
([ai-recipe-draft.service.ts](../../apps/api/src/recipes/ai-recipe-draft.service.ts)):
the provider, the model, what was wrong and the first 500 characters of what the
model answered, so the cause can be read and need not be guessed.

---

## Limits on every request

Every request to a model carries three limits, set per kind of request in
[apps/api/src/ai/operations.ts](../../apps/api/src/ai/operations.ts). No request
runs on a provider's defaults.

| Request | Wait | Output cap | Temperature |
|---|---|---|---|
| AI meal swap, AI ingredient suggestion | 60 s | 400 tokens | 0.2 |
| Weighing what the planner proposes | 60 s | 700 tokens | 0.2 |
| Recipe draft from prompt | 60 s | 1,800 tokens for one language, 1,200 more for each further one | 0.7 |
| Swap rewrite | 20 s | 3,000 tokens | 0.3 |
| Admin recipe batch | 180 s per call | about 1,100 tokens per recipe in one language, 700 more for each further one | 0.2 |
| Admin ingredient names | 180 s per call | about 80 tokens per name in one language | 0.2 |
| Admin missing language | 180 s per call | 300 tokens and 120 more for each step of the recipe | 0.2 |

- **The wait covers the whole failover chain.** With one provider it gets the
  full wait. With several, each provider still to be tried gets an equal share
  of what is left: a chain of a local model and a cloud model gives the local
  one 30 seconds, and the cloud one everything that remains. A provider that
  fails at once (a wrong key, a refused connection) costs the next one nothing.
- **A provider is called once.** The API does not let the provider libraries
  retry on their own; trying the next provider is the router's decision.
- **A wait that runs out is reported as such.** The user sees that the model
  was too slow, and the engine's own pick is used where there is one.
- **An answer that reaches its cap is treated as cut off.** The caps are about
  twice a typical answer. Admin runs ask again and show `answer-cut-off`.
- **What a user waits for is asked for without thinking.** A model that thinks
  before it answers is billed for the thinking as output, and the thinking
  counts against the cap: asked to weigh three options, `openai/gpt-6-luna`
  spent all 700 tokens on it and answered nothing. The requests an account
  makes (a swap, a substitute, a rewording, a recipe, a weighing) therefore
  carry OpenRouter's setting for no thinking (`reasoning.effort: "none"`),
  which it turns into each vendor's own and leaves out for a model that does
  not think. A model whose thinking cannot be turned off refuses such a
  request at once and unbilled; it is asked once more without the setting, in
  the time that is left. The runs of the administrator's panel carry no such
  setting, and neither do requests made to OpenAI, Anthropic or Ollama
  directly: what a setting does there was not measured.
- **A model that translates writes words and nothing else.** The run that
  fills a language recipes lack sends the title, the description and the steps
  of one recipe, and no ingredient, amount or figure. What comes back has to
  have as many steps as the English and no number the English does not have,
  and must not be the English again; an answer that fails is asked for once
  more and then left. What passes goes into the curation queue as a draft: a
  person approves it before anything a user sees changes.
- **A model that weighs adds nothing.** Other ways to fill a day, swaps that
  use up an opened pack and what a shopping list could do without are worked
  out by the engine, with or without a model, and are the same either way. A
  model is shown them under letters with the figures the engine counted, and
  answers with an order and a sentence for each. A letter it makes up is
  ignored, an option it leaves out keeps its place after the ones it named,
  and an answer that names none leaves the engine's order with a line that
  says so.
- **Admin batches are split into calls.** A run of 25 recipes in two languages
  is nine calls of three recipes or fewer; each call sees what the earlier ones
  wrote, so the run does not repeat itself. A rejected call fails only its own
  recipes.
- **An account's own recipes are limited.** An account holds at most 200
  recipes of its own (drafts a model wrote and recipes with a swapped
  ingredient), and a model writes at most 20 recipes for it in 24 hours,
  whoever pays for the calls. Neither number is a setting. A recipe its owner
  deleted is removed for good by the worker a week later, once no plan,
  favourite or pending curation draft uses it.
- **Users' recipes stay out of the curation queue** unless the owner sends one
  in ("Suggest for the shared library" on their recipes), or a second user
  comes to own the same recipe. The draft in the queue shows the recipe, not
  who made it.
- **An ingredient swap asks no model unless the user ticks the box.** The
  substitute's name then replaces the old one in the text of every language.
  With the box ticked, one call rewords the text in the language the user
  reads; the other languages keep the plain replacement. An answer that still
  names the removed ingredient, changes the number of steps or adds a number
  is thrown away, and the plain replacement stands.

The web front-end and any reverse proxy in front of it must wait longer than
the API does; see [Reverse proxy](deployment.md#reverse-proxy).

---

## Recommendations by hardware tier

### Tier 1 — Cloud (recommended starting point)

**Pick a cloud provider for recipe drafting and admin batch generation
unless you have real GPU hardware on hand.** The strict-JSON + 2-locale
prompt is the single most demanding thing this app ever asks a model to do,
and the cost is small (drafting a recipe is one short request).

#### What the project uses

An instance has one operator model (`AI_DEFAULT_MODEL`), and the project is
developed and checked against one: `openai/gpt-6-luna` through OpenRouter, for
what an account asks and for the runs of the administrator's panel alike.

| For | What was measured of it |
|---|---|
| What an account asks: a swap, a substitute, a rewording, a recipe of its own, a weighing | Every call answered whole in one to five seconds, the seven of them for a tenth of a cent. It needs the setting for no thinking that these requests carry (see [Limits on every request](#limits-on-every-request)): without it every weighing was cut off. |
| The admin recipe batch, which writes the drafts of the shared catalogue | Wrote every recipe it was asked for, drew on the widest part of the catalogue, kept to the rules of the prompt, and cost the least of the models tried. |
| The admin naming run, which names imported ingredients in a language | What it does least well. On a sample of 25 it kept the qualifiers of the description ("Kotlet schabowy ze środkowej części schabu") where `google/gemini-3.1-flash-lite` gave the name a shop shelf has ("Kotlet schabowy"). A name is a draft either way, and is shortened in the queue; of the other model's, about one in fifteen needed that as well. |

A draft for the shared catalogue is held to the rules by the validator, and
approved by a person in each language before it ships.

#### Measured for what an account asks

The six calls an account makes (a meal swap, a substitute, a recipe of its
own and the three weighings), with the prompts the application sent, in
Polish, on 2026-10-13 through OpenRouter. "As it is set up" is a request
without the setting for no thinking; "asked not to think" carries it.

| Model | Request | Answered whole | Time a call | The six cost |
|---|---|---|---|---|
| `openai/gpt-6-luna` | asked not to think | 6 of 6 | 1.5 to 4.6 s | $0.0009 |
| `openai/gpt-6-luna` | as it is set up | 3 of 6: each weighing spent its 700 tokens on thinking | 4.5 to 11.6 s | $0.0019 |
| `google/gemini-3.1-flash-lite` | either; it does not think | 6 of 6 | 1.0 to 5.9 s | $0.0032 |

Two of the weighings were also put to the models that had failed the recipe
batch by thinking:

| Model | As it is set up | Asked not to think |
|---|---|---|
| `deepseek/deepseek-v4-pro` | cut off at the cap after 7 to 12 s | whole in 2.5 to 2.7 s |
| `qwen/qwen3.7-plus` | cut off after 13 s | whole in 2.5 to 3.1 s |
| `mistralai/mistral-large-4-0` | cut off after 10 to 32 s | whole in 6 to 12 s |
| `openai/gpt-5.4-mini` | whole in 1.6 to 2.0 s | whole in 1.3 to 1.5 s |
| `google/gemini-3.8-flash` | cut off after 6 s | refuses the setting ("Reasoning is mandatory for this endpoint"), so it is asked as it is set up, and is cut off |

On an instance with `openai/gpt-6-luna` as its model, the same calls and a
rewording made through the application all completed, in 1.2 to 5.4 seconds
each and none at its cap.

#### Measured for the admin recipe batch

The same run on 2026-10-13, through OpenRouter: twelve recipes in English and
Polish for the diets and meals the catalogue had fewest of (low-carb and keto
mostly), from an empty queue, against the 93 curated ingredients. Prices are
those of the day, per million tokens.

| Model | Price, in / out | Recipes written | Time | The run cost | What came back |
|---|---|---|---|---|---|
| `openai/gpt-6-luna` | $0.10 / $0.50 | 12 of 12 | 171 s | $0.014 | 35 different ingredients, fat-rich keto dishes, each dish filed under the meals it is, natural Polish. One recipe seasoned with salt its list did not hold. |
| `google/gemini-3.1-flash-lite` | $0.25 / $1.50 | 11 of 12 | 56 s | $0.025 | The fastest. 22 ingredients, the same few dishes over again, and a title that named an ingredient the catalogue does not have. |
| `openai/gpt-5.4-mini` | $0.75 / $4.50 | 7 of 12 | 80 s | $0.116 | Nine recipes refused for missing the diet they were asked for. |
| `deepseek/deepseek-v4-pro` | $0.44 / $0.87 | 3, stopped after 8 min | | $0.020 | Answers cut off at the output cap. |
| `qwen/qwen3.7-plus` | $0.32 / $1.28 | none, stopped after 11 min | | $0.060 | Every answer cut off. |
| `mistralai/mistral-large-4-0` | $0.68 / $2.09 | none in 13 min | | $0.080 | Cut off, then timed out. |
| `google/gemini-3.8-flash` | $0.75 / $3.75 | none, stopped after 3 min | | $0.042 | Every answer cut off. |

- **A model that thinks before it answers may write nothing.** Four of the
  seven spent the output cap of a call on thinking and returned an empty
  answer. A run of the panel sends a model no setting for how long it may
  think, so for the recipe batch choose a model that answers directly or
  thinks briefly by default. A run says so as `answer-cut-off`; stop it, since
  every call is paid for.
- **Price is no guide.** The model that did best was the cheapest of the
  seven; the dearest one that answered wrote the least.
- **What the table does not say.** Model ids and prices change within weeks:
  read the provider's list before copying one. No model of Anthropic and no
  free model was measured. The free models this guide used to name have left
  OpenRouter's list, and the one tried on that day
  (`google/gemma-4-31b-it:free`) answered 429 at once. A whole batch on a paid
  model costs one to three cents.
- **A direct OpenAI or Anthropic key works the same way**: set the provider
  and one of its models. The figures above are for the models named, not for
  a provider.

On the same day `openai/gpt-6-luna` wrote the thirty recipes that brought every
diet to six for every meal, in two runs and for under four cents, and after
them the recipes asked for by diet and meal, every run complete.

Whatever the model, a batch is held to the same rules by the validator: a
recipe that breaks one is refused and asked for again, and a person approves
every draft before it ships.

### Tier 2 — Self-hosted Ollama on a real GPU

"Real" means **≥12 GB VRAM** so a 14B Q4 model fits entirely on the GPU.
Anything less and you are partial-offloading, which collapses to <5 tok/s
and runs out of the 60-second wait on the recipe-draft prompt.

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
needs a model that simply does not run fast enough on CPU/iGPU to answer
inside the 60-second wait. Use cloud for those surfaces and reserve local
Ollama for the lighter ones.

| Surface | Viable model on CPU/iGPU | Notes |
|---|---|---|
| AI meal/ingredient swap | `llama3.2:3b`, `qwen2.5:3b` | Borderline; pick fixed candidates so the prompt is short. |
| Admin missing language | `qwen2.5:3b`, `gemma3:4b` | One recipe a call; works but slow on CPU. |
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
  reviewer interface is the right surface for polishing low-end output rather
  than jumping to a bigger model.
- **An admin batch is judged recipe by recipe.** A model repeats itself: in a
  run of 25 recipes it proposes again a dish it wrote two calls earlier, or the
  same ingredients under another name, and it writes a slug as its language
  spells the word (`sauté`). A recipe that is refused costs that one recipe:
  the others of the answer are kept, the next attempt of the call asks only
  for those still missing and says what was refused, and a slug is taken as
  the plain one it means. The naming run judges a name the same way: one
  name refused leaves the other nineteen of its call standing. Measured on 2026-10-13 with
  `google/gemini-3.1-flash-lite` through OpenRouter: 23 of 25 recipes in
  English and Polish written in a minute and a half for about seven US cents,
  and no answer cut off by the output cap. The lighter surfaces (a swap, a
  substitute, a rewording, a weighing) answered in one to two seconds each.
- **A model fills what it was asked for the cheapest way it can.** Asked for
  a snack on a diet that has few, it files a dinner under "lunch, dinner,
  snack". It puts the diet or the band into the title ("Keto ...",
  "Simple ..."), names in a title or a step what its ingredient list does not
  hold (a "parmesan crust" of feta, "season with salt" without salt), and
  breaks off its second language halfway. The validator refuses each of
  these: a dish is a main one or a small one, a title names the dish and no
  diet, a title or a step names no ingredient of the catalogue that the list
  lacks, and every language has as many steps as the others. A refused
  recipe is asked for again with the reason.
- **A run for a diet is told what the diet aims at.** A recipe that only
  passes a diet's rule can leave its plans far from their split: "keto"
  dishes of lean turkey pass the limit on carbohydrate and bring a third of
  the fat a keto day wants. The prompt gives the split a day on the diet aims
  at, and the words of the run (`cuisine`) can ask for more: "lean cuts,
  low-fat dairy, little oil" moved the plans of the high-protein diet from 14
  points off their split to under 4.
- **Temperature.** A recipe draft runs at `0.7` for variety; picking from a
  list, naming and translation run at `0.2` for fidelity. Don't raise the
  translation temperature — it produces "creative" mistranslations that pass
  the validator.

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
or rate-limits, the request moves on to the next one; the providers of a
chain share the wait of the request, as described under
[Limits on every request](#limits-on-every-request).

---

## Quick-pick

If you don't want to read the table:

- **You want it to work today, for cents** → OpenRouter with
  `openai/gpt-6-luna` as the admin default, for everything.
- **You have a 12 GB+ GPU** → local Ollama with `qwen2.5:14b`.
- **You self-host and have no GPU** → a cloud model for recipe drafting and
  batches; local Ollama only for the lighter surfaces (Tier 3).
