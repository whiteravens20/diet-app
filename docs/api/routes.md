# The routes of the API

Written by `npm run contract` from the controllers; a test fails when this file is not what the command writes. The same routes with every schema in full are in [`openapi.json`](openapi.json).

170 routes. Every request that is refused is answered with an `ApiError`: a status, a code and a sentence. A route that names no limit of its own is under the general one of the instance (`RATE_LIMIT_MAX` requests in `RATE_LIMIT_WINDOW` seconds for each sender).

## admin

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/admin/accounts/operator-ai` | the administrator | Who may use the operator's AI provider (`AI_ADMIN_ACCESS`), and how many accounts are approved for it. |  | 200 `AdminOperatorAi` |  |
| `PUT /api/admin/accounts/operator-ai` | the administrator | Approve the account of an address for the operator's AI provider. It counts while `AI_ADMIN_ACCESS` is `approved`. Approving it again changes nothing; an address without an account is 404. | `OperatorAiApproval` | 204 | 30 in a minute |
| `DELETE /api/admin/accounts/operator-ai` | the administrator | Take the approval of the account of an address back. An address without an account is 404. | `OperatorAiApproval` | 204 | 30 in a minute |
| `DELETE /api/admin/accounts/second-factor` | the administrator | Take the second factor off the account of an address: for a holder who lost the authenticator app and the recovery codes. The account signs in with its password alone afterwards, and is told so by mail. Whether the one who asks is the holder is for the operator to make sure of. | `AccountSecondFactorRemoval` | 204 | 10 in a minute |
| `GET /api/admin/connection` | the administrator | What the API sees of the connection the administrator is on. Opened through the public address of the instance, it shows whether the reverse proxy passes the client's address on and whether `TRUST_PROXY` is set to believe it. |  | 200 `AdminConnection` |  |
| `POST /api/admin/db/import-usda` | the administrator | Start an import of foods from USDA FoodData Central, in the background. It writes `ingredients.generated.json` into the data directory, and a catalogue update then loads what it wrote. `?dataTypes=` names the data types of this run (`Foundation,SR Legacy`) in the place of `FDC_DATA_TYPES`. | query `UsdaImportQuery` | 202 `FoodImportState` |  |
| `GET /api/admin/db/import-usda/status` | the administrator | Where the import of foods stands. |  | 200 `FoodImportState` |  |
| `POST /api/admin/db/update` | the administrator | Start the catalogue update: the data files are loaded into the database, in the background. 409 while one is running; `db/update/status` says where it stands. |  | 202 `CatalogueUpdateState` |  |
| `GET /api/admin/db/update/status` | the administrator | Where the catalogue update stands. |  | 200 `CatalogueUpdateState` |  |
| `GET /api/admin/ingredients` | the administrator | The ingredients of the catalogue whose name holds `search`: what a retired one can be replaced by. | query `IngredientListQuery` | 200 a list of `Ingredient` |  |
| `POST /api/admin/ingredients/:id/replace` | the administrator | Replace a retired ingredient by one of the catalogue: what uses it moves over, with each amount kept, what is worked out from the ingredients of recipes outside the seed is worked out again, the retired ingredient goes, and the instance's files are written again. The text of a recipe is not changed: one that names the old food is for a person to correct. | `ReplaceIngredientRequest` | 200 `ReplacedIngredient` |  |
| `GET /api/admin/ingredients/retired` | the administrator | The retired ingredients that something of the instance still uses, with what uses them. |  | 200 a list of `RetiredIngredient` |  |
| `GET /api/admin/instance-settings` | the administrator | What an administrator sets for the instance in the panel: whether reviewers may sign in, and whether their password is set. |  | 200 `InstanceSettingsDto` |  |
| `PATCH /api/admin/instance-settings` | the administrator | Change those settings. | `InstanceSettingsPatchBody` | 200 `InstanceSettingsDto` |  |
| `GET /api/admin/session` | anyone | What the admin pages ask first. Says nothing but whether a panel exists, whether this browser is in, and whether signing in takes a code. |  | 200 `AdminSessionState` |  |
| `POST /api/admin/session` | anyone | Sign the administrator in: the password, and a code where the second factor is on. The session is a cookie. | `AdminSignInRequest` | 204 | 10 in a minute |
| `DELETE /api/admin/session` | anyone | Sign out of this browser. |  | 204 |  |
| `POST /api/admin/session/end-all` | the administrator | End every admin session there is, this one too: for when a session may be in the wrong hands. |  | 204 |  |
| `POST /api/admin/session/second-factor` | the administrator | The first code: signing in to the panel takes one from now on. Every admin session there is began with the password alone and ends; this browser, which has shown the code, gets a new one. | `SecondFactorConfirmRequest` | 204 | 10 in a minute |
| `DELETE /api/admin/session/second-factor` | the administrator | Switch the second factor off: the panel opens with the password alone again. | `AdminSecondFactorOffRequest` | 204 | 5 in a minute |
| `POST /api/admin/session/second-factor/setup` | the administrator | A secret to set an authenticator app up with. It counts from the first code on (`POST second-factor`). | `AdminSecondFactorSetupRequest` | 200 `SecondFactorSetup` | 5 in a minute |
| `GET /api/admin/stats` | the administrator | What the catalogue holds: its counts, how many recipes each diet has for each meal and how many drafts wait for each, what the plans of each diet reach, and whether the data files have changed since they were last loaded. |  | 200 `AdminStats` |  |
| `GET /api/admin/status` | anyone | Whether the panel is on. Anyone may ask: the page does, before there is a session. |  | 200 `AdminStatus` |  |

## admin/drafts

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/admin/drafts/ingredient-names` | the administrator | The drafts of names for ingredients, a page at a time, narrowed as asked. | query `IngredientNameDraftListQuery` | 200 `IngredientNameDraftPage` |  |
| `GET /api/admin/drafts/ingredient-names/:id` | the administrator | One draft of a name. |  | 200 `IngredientNameDraft` |  |
| `DELETE /api/admin/drafts/ingredient-names/:id` | the administrator | Remove a draft of a name. |  | 204 |  |
| `PATCH /api/admin/drafts/ingredient-names/:id` | the administrator | Change what a draft of a name suggests. | `IngredientNameDraftPatchBody` | 200 `IngredientNameDraft` |  |
| `POST /api/admin/drafts/ingredient-names/:id/approve` | the administrator | Approve a draft of a name, in the language asked for. | `DraftReviewBody`, query `TargetLocaleQuery` | 201 `IngredientNameDraft` |  |
| `POST /api/admin/drafts/ingredient-names/:id/reject` | the administrator | Reject a draft of a name, in the language asked for, with a reason. | `DraftReviewBody`, query `TargetLocaleQuery` | 201 `IngredientNameDraft` |  |
| `POST /api/admin/drafts/ingredient-names/generate` | the administrator | Start the run that asks a model for names of ingredients. 409 while one is running. | `IngredientNameGenerateSpec` | 202 `DraftRunnerState` | 5 in a minute |
| `GET /api/admin/drafts/ingredient-names/generate/status` | the administrator | Where the run of names stands. |  | 200 `DraftRunnerState` |  |
| `POST /api/admin/drafts/ingredient-names/generate/stop` | the administrator | Stop the run of names. What it has written stays. |  | 202 `DraftRunnerState` |  |
| `POST /api/admin/drafts/ingredient-names/reject` | the administrator | Reject up to a hundred drafts of ingredient names with one reason, each in its first language: what the queue is cleared with before the names are written again. Answers which were rejected and which were left out, each with the refusal a single rejection would have got. | `DraftBulkRejectBody` | 200 `RejectedDrafts` |  |
| `GET /api/admin/drafts/recipes` | the administrator | The recipe drafts, a page at a time, narrowed as asked. | query `RecipeDraftListQuery` | 200 `RecipeDraftPage` |  |
| `GET /api/admin/drafts/recipes/:id` | the administrator | One recipe draft. |  | 200 `RecipeDraft` |  |
| `DELETE /api/admin/drafts/recipes/:id` | the administrator | Remove a recipe draft. |  | 204 |  |
| `PATCH /api/admin/drafts/recipes/:id` | the administrator | Change a recipe draft. With `?dryRun=true` the result is answered and not stored: what the editor shows the nutrition of an edit with. | `RecipeDraftPatch`, query `DryRunQuery` | 200 `RecipeDraft` |  |
| `POST /api/admin/drafts/recipes/:id/approve` | the administrator | Approve a recipe draft, in the language asked for. | `DraftReviewBody`, query `DraftLocaleQuery` | 201 `RecipeDraft` |  |
| `POST /api/admin/drafts/recipes/:id/promote` | the administrator | Promote a recipe users made to the shared library: the one draft is shipped into this instance, on the terms of every local ship, and the instance's files are written again. The personal recipes it stands for are left as they are; whoever makes the recipe again is given the shared one. |  | 201 `RecipeDraft` |  |
| `POST /api/admin/drafts/recipes/:id/reject` | the administrator | Reject a recipe draft, in the language asked for, with a reason. | `DraftReviewBody`, query `DraftLocaleQuery` | 201 `RecipeDraft` |  |
| `POST /api/admin/drafts/recipes/generate` | the administrator | Start the run that asks a model for recipe drafts. 409 while one is running. | `RecipeGenerateSpec` | 202 `RecipeRunState` | 5 in a minute |
| `GET /api/admin/drafts/recipes/generate/status` | the administrator | Where the run of recipes stands. |  | 200 `RecipeRunState` |  |
| `POST /api/admin/drafts/recipes/generate/stop` | the administrator | Stop the run of recipes. What it has written stays. |  | 202 `RecipeRunState` |  |
| `POST /api/admin/drafts/recipes/import` | the administrator | Take recipes in from a document the operator has: those that resolve against the catalogue become drafts, in English, with where they are from; the others are refused with their reasons and kept for the administrator to look through. With `dryRun` nothing is written. No model is asked and nothing is fetched. | `RecipeImportRequest` | 200 `RecipeImportResult` | 10 in a minute |
| `GET /api/admin/drafts/recipes/import/rejections` | the administrator | The recipes that imports refused, each with the reasons. |  | 200 a list of `StoredImportRejection` |  |
| `DELETE /api/admin/drafts/recipes/import/rejections` | the administrator | Forget the recipes that imports refused. |  | 204 |  |
| `POST /api/admin/drafts/recipes/reject` | the administrator | Reject up to a hundred recipe drafts with one reason: what the queue is cleared with when users sent what nobody will ship. Answers which were rejected and which were left out, each with the refusal a single rejection would have got. | `DraftBulkRejectBody` | 200 `RejectedDrafts` |  |
| `POST /api/admin/drafts/ship` | the administrator | Ship the approved drafts of a kind: into this instance, or as a file to save. | `ShipRequest` | 201 `ShipResult` |  |
| `GET /api/admin/drafts/ship/config` | the administrator | The ways drafts can be shipped on this instance, and how many are approved and wait. |  | 200 `ShipConfig` |  |
| `GET /api/admin/drafts/ship/current-overrides` | the administrator | The names this instance has given its ingredients, as the file `data/` keeps them: to carry them to another instance or repository at any time, whatever has shipped. |  | 200 a file |  |
| `POST /api/admin/drafts/ship/mark-shipped` | the administrator | Mark drafts as shipped, once the file a bundle gave is where it belongs. | `MarkShippedRequest` | 201 `Updated` |  |
| `POST /api/admin/drafts/ship/restore` | the administrator | Read the instance's own files back into the database: the way to carry the recipes and names it added to a new server. Repeatable; see `ship/restore.ts`. |  | 200 `RestoredFromInstanceData` |  |
| `POST /api/admin/drafts/translations/generate` | the administrator | Start the run that fills a language recipes lack. What it writes are drafts for the queue; nothing live changes until a person has approved them and they ship. | `TranslationGenerateSpec` | 202 `DraftRunnerState` | 5 in a minute |
| `GET /api/admin/drafts/translations/generate/status` | the administrator | Where the run that fills a language stands. |  | 200 `DraftRunnerState` |  |
| `POST /api/admin/drafts/translations/generate/stop` | the administrator | Stop the run that fills a language. What it has written stays. |  | 202 `DraftRunnerState` |  |

## ai

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/ai/providers` | an account | The AI providers the account has set up, without their keys. |  | 200 a list of `AiProviderConfig` |  |
| `PUT /api/ai/providers` | an account | Save the account's configuration of a provider: made the first time, changed afterwards. A key that is left out stays as it is. | `AiProviderConfigInput` | 200 `AiProviderConfig` |  |
| `DELETE /api/ai/providers/:id` | an account | Remove a provider of the account, with its key. |  | 204 |  |
| `GET /api/ai/quota` | an account | What AI the account has now: the mode it chose, and how many calls of the instance's allowance it has made and has left. |  | 200 `AiQuotaStatus` |  |
| `POST /api/ai/test` | an account | Verify a provider credential without persisting it. The UI calls this from the BYOK form to confirm the key works and populate the model dropdown. | `AiTestConnectionRequest` | 201 `AiTestConnectionResponse` | 20 in a minute |

## auth

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `POST /api/auth/browser-code` | anyone | A code that signs a browser in to the account of a client that keeps its own tokens: for the refresh token of its session, which is replaced by a new one as a refresh replaces it. An account gets at most 30 codes in an hour. | `BrowserCodeRequest` | 200 `BrowserCode` | 30 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/browser-sign-in` | anyone | Sign this browser in with a code from an application: a session of its own for a day, in cookies, which takes the place of the session the browser had. Only the application's own pages may ask. | `BrowserSignInRequest` | 200 `AuthResponse` | 10 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/browser-sign-in/account` | anyone | Whose account a code from an application is for, without using the code. Only the application's own pages may ask. | `BrowserSignInRequest` | 200 `BrowserCodeAccount` | 10 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/confirm-email-change` | anyone | Confirm a new address with the token from the mail that was sent to it. | `ConfirmEmailChangeRequest` | 204 | 10 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/login` | anyone | Sign in with an address and a password. An account with a second factor gets a challenge in the place of a session. | `LoginRequest` | 200 `LoginResponse` | 30 in 15 minutes; 10 in 15 minutes for what it tries; 50 in 15 minutes for what it tries |
| `POST /api/auth/login/second-factor` | anyone | The second step of signing in: the challenge of the first, and a code. | `SecondFactorSignInRequest` | 200 `AuthResponse` | 10 in a minute; 10 in 5 minutes for what it tries |
| `POST /api/auth/logout` | anyone | End the session of the refresh token. | `RefreshRequest` | 204 | 30 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/password-reset/confirm` | anyone | Set a new password with the token from the mail. | `PasswordResetConfirm` | 204 | 10 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/password-reset/request` | anyone | Ask for a mail with a link to set a new password. The answer says nothing of whether the address has an account. | `PasswordResetRequest` | 202 | 15 in 15 minutes; 5 in 15 minutes for what it tries |
| `POST /api/auth/refresh` | anyone | A new access token for a refresh token, which is replaced by a new one. | `RefreshRequest` | 200 `AuthResponse` | 30 in a minute; 10 in a minute for what it tries |
| `POST /api/auth/register` | anyone | Open an account, and a session with it. An address opens at most three accounts a day, where the instance knows the client's address (`TRUST_PROXY`); the fourth is 429 `TOO_MANY_SIGN_UPS`. | `RegisterRequest` | 201 `AuthResponse` | 10 in a minute |
| `POST /api/auth/verify-email` | anyone | Confirm the account's address with the token from the mail. | `VerifyEmailRequest` | 204 | 10 in a minute; 10 in a minute for what it tries |

## config

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/config` | anyone | What a page has to know before anybody has signed in: whether signing up asks for a challenge, whether mail is on, what AI the instance offers and how deep its catalogue is. |  | 200 `PublicConfig` |  |

## csp-reports

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `POST /api/csp-reports` | anyone | Take a browser's report of something a page was not allowed to do. | `PolicyReport` | 204 | 60 in a minute |

## favorite-sets

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/favorite-sets` | an account | The favourite sets of a profile. | `?profileId=` | 200 a list of `FavoriteSet` |  |
| `POST /api/favorite-sets` | an account | Make a set: a recipe for each meal it names. | `CreateFavoriteSetRequest` | 201 `FavoriteSet` |  |
| `DELETE /api/favorite-sets/:id` | an account | Delete a set. |  | 204 |  |
| `PATCH /api/favorite-sets/:id` | an account | Change a set's name or its recipes. | `UpdateFavoriteSetRequest` | 200 `FavoriteSet` |  |
| `POST /api/favorite-sets/:id/apply` | an account | Put the recipes of a set on a day of a plan. | `ApplyFavoriteSetRequest` | 201 `MealPlan` |  |

## favorites

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/favorites` | an account | The recipes a profile marked, narrowed and ordered as asked. | query `FavoriteListQuery` | 200 a list of `MarkedRecipe` |  |
| `POST /api/favorites` | an account | Mark a recipe for a profile. Marking it again replaces what was said before. | `AddFavoriteRequest` | 201 `FavoriteMark` |  |
| `DELETE /api/favorites/:profileId/:recipeId` | an account | Take the mark off a recipe. |  | 204 |  |

## health

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/health` | anyone | Whether the API is up and reaches its database: 200, or 503 with the database down. |  | 200 `Health` |  |

## ingredients

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/ingredients` | an account | Search the curated ingredient database. `?ids=` resolves a specific list (used by the profile page to render saved favourite/avoid entries by name); `?search=` does a case-insensitive name match. | query `IngredientListQuery` | 200 a list of `Ingredient` |  |

## inventory

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/inventory` | an account | What a profile's pantry holds, by aisle and by name as the request's language sorts names. | `?profileId=` | 200 a list of `InventoryItem` |  |
| `POST /api/inventory` | an account | Put something into the pantry: added to the row of that ingredient and unit, or a new row; what is counted, to its row in pieces. | `UpsertInventoryItemRequest` | 201 `InventoryItem` |  |
| `DELETE /api/inventory/:id` | an account | Take a row out of the pantry. |  | 204 |  |
| `PATCH /api/inventory/:id` | an account | Change a row of the pantry. | `PatchInventoryItem` | 200 `InventoryItem` |  |

## meal-plans

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/meal-plans` | an account | The plans of a profile, a page at a time, narrowed by their days and by whether they are over. | query `PlanListQuery` | 200 `MealPlanPage` |  |
| `GET /api/meal-plans/:id` | an account | One plan, with its days and their meals. |  | 200 `MealPlan` |  |
| `DELETE /api/meal-plans/:id` | an account | Delete a plan. Its shopping lists go with it, and what was obtained for days still ahead goes into the pantry. |  | 204 |  |
| `POST /api/meal-plans/:id/days/:date/custom-meal` | an account | Add a user-authored custom meal to a day. | `AddCustomMealRequest` | 201 `RebalanceResult` | 60 in a minute |
| `POST /api/meal-plans/:id/days/:dayId/regenerate` | an account | Re-roll the meals of a single day. | `RegenerateDayRequest` | 201 `MealPlan` | 20 in a minute |
| `PUT /api/meal-plans/:id/days/:dayId/settings` | an account | Change the settings of a day of a running plan, as the preview at `revision` said. Draws recipes as making the day again does. | `ApplyDaySettingsRequest` | 200 `MealPlan` | 20 in a minute |
| `POST /api/meal-plans/:id/days/:dayId/settings/preview` | an account | What changing the settings of a day would do: its target, and which of its meals stay, change their amount, get another recipe or go. Nothing is written. Asked again as the settings are changed in a window, so it is held to what a window asks for in a minute. | `DaySettings` | 200 `DaySettingsPreview` | 60 in a minute |
| `POST /api/meal-plans/:id/days/:dayId/variations` | an account | Other ways to fill a day: the engine makes them as it makes a day again, and a model puts them in order and says a sentence of each when the request asks for one. Nothing is written. One request makes the day up to eight times over, so it is held to half of what making a day again is. | `WeighRequest` | 200 `DayVariations` | 10 in a minute |
| `POST /api/meal-plans/:id/days/:dayId/variations/take` | an account | Fill a day the way it was offered. | `TakeDayVariationRequest` | 200 `MealPlan` | 20 in a minute |
| `DELETE /api/meal-plans/:id/meals/:mealId` | an account | Take a meal off its day, whichever it is (rebalances the day). |  | 200 `RebalanceResult` |  |
| `PATCH /api/meal-plans/:id/meals/:mealId/eaten` | an account | Mark a planned meal eaten or not eaten (rebalances the day). | `SetMealEatenRequest` | 200 `RebalanceResult` |  |
| `GET /api/meal-plans/:id/meals/:mealId/substitutes` | an account | The substitutes the catalogue's own rules name for the ingredients of a planned meal. |  | 200 a list of `SubstituteSuggestion` |  |
| `POST /api/meal-plans/:id/rebalance` | an account | Share what a day, or the rest of the plan, has left among its meals again, or put servings back as the `restore` of an earlier answer says. | `RebalanceRequest` | 201 `RebalanceResult` | 60 in a minute |
| `POST /api/meal-plans/:id/regenerate` | an account | Make a plan again, or the days of it that the request names. | `RegenerateRequest` | 201 `MealPlan` | 20 in a minute |
| `POST /api/meal-plans/:id/use-up` | an account | Swaps that would use up what the plan opens: the engine finds them, and a model puts them in order and says a sentence of each when the request asks for one. Nothing is written; a suggestion is taken as any swap is. The limit is that of making a plan: every meal of the plan is looked at. | `WeighRequest` | 200 `UseUpSuggestions` | 20 in a minute |
| `POST /api/meal-plans/ai-swap-meal/preview` | an account | A recipe to put in the place of a planned meal, as `swap-meal/preview` offers one, with a model asked which of the recipes the engine puts before it to take. `aiMeta` says who picked; nothing is written. | `AiSwapMealRequest` | 201 `AiMealSwapPreview` | 30 in a minute |
| `GET /api/meal-plans/calendar` | an account | The days of the profile's plans in a span of days, for a calendar. | query `PlanCalendarQuery` | 200 `PlanCalendar` | 60 in a minute |
| `POST /api/meal-plans/generate` | an account | Make a plan for a profile: the planner fills its days within the limits of the profile. 422 `PLAN_NEEDS_RELAXATION` when it cannot, with the limits that would have to give way. | `GeneratePlanRequest` | 201 `MealPlan` | 20 in a minute |
| `GET /api/meal-plans/overview` | an account | What the profile's plan of the moment comes to. | query `PlanOverviewQuery` | 200 `PlanOverviewAnswer` |  |
| `POST /api/meal-plans/swap-ingredient/ai-suggest` | an account | AI-ranked ingredient suggestion. Returns just an `ingredientId`; the caller still runs preview/apply so nutrition is engine-recomputed. | `AiSuggestIngredientRequest` | 201 `AiSuggestIngredientResponse` | 30 in a minute |
| `POST /api/meal-plans/swap-ingredient/apply` | an account | Make a substitution: the meal gets a recipe of the account's own, the planned one with the ingredient swapped. | `SwapIngredientRequest` | 201 `SwapIngredientResponse` | 30 in a minute |
| `POST /api/meal-plans/swap-ingredient/preview` | an account | What swapping an ingredient of a meal for another would do to the meal. Nothing is written. | `SwapIngredientRequest` | 201 `SwapPreview` |  |
| `POST /api/meal-plans/swap-meal` | an account | Make a swap that was offered, on the plan as it was when the offer was made. | `ApplyMealSwapRequest` | 201 `RebalanceResult` |  |
| `POST /api/meal-plans/swap-meal/preview` | an account | A recipe to put in the place of a planned meal, with what the swap would do. Nothing is written. | `SwapMealRequest` | 201 `MealSwapPreview` |  |

## notifications

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `POST /api/notifications/:id/read` | an account | Mark a notification as read. |  | 204 |  |
| `POST /api/notifications/read-all` | an account | Mark every notification of the account as read, and say how many there were. |  | 200 `Updated` |  |
| `GET /api/notifications/unread` | an account | The notifications of the account that are not read yet. |  | 200 a list of `Notification` |  |

## profiles

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/profiles` | an account | The profiles of the account. |  | 200 a list of `Profile` |  |
| `POST /api/profiles` | an account | Add a profile to the account. | `ProfileInput` | 201 `Profile` |  |
| `GET /api/profiles/:id` | an account | One profile. |  | 200 `Profile` |  |
| `PUT /api/profiles/:id` | an account | The profile as it is from now on: every part of it. A part that is left out is refused. | `ProfileUpdate` | 200 `Profile` |  |
| `DELETE /api/profiles/:id` | an account | Delete a profile, with its plans, lists and pantry. |  | 204 |  |
| `GET /api/profiles/:id/calories` | an account | What the profile's figures come to: its calorie target and how it is worked out, and the protein, fat and carbohydrate of it. |  | 200 `CalorieCalculation` |  |
| `PATCH /api/profiles/:id/preferences` | an account | Change some of the profile's preferences: what is left out stays as it is. | `ProfilePreferencesPatch` | 200 `Profile` |  |
| `POST /api/profiles/calories` | an account | The calorie target and macros that figures somebody typed would come to, and what each pace of loss would: for a form that shows them before there is a profile. Nothing is kept. | `CaloriePreviewRequest` | 200 `CaloriePreview` |  |

## recipes

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/recipes` | an account | The recipe library: the shared recipes and the account's own, narrowed as asked, a page at a time. | query `RecipeSearchQuery` | 200 `RecipeSearchPage` |  |
| `POST /api/recipes` | an account | Write a recipe of the account's own by hand, in the language of the request, from ingredients of the catalogue. The engine works out its nutrition, allergens and diets. A recipe of the library with the same ingredients does not stand in for it; one of the account's own does (409 `RECIPE_ALREADY_YOURS`, naming it). At most 50 are written or edited by hand in 24 hours (429 `OWN_RECIPE_DAILY_LIMIT`). | `OwnRecipeInput` | 201 `Recipe` | 10 in a minute |
| `GET /api/recipes/:id` | an account | One recipe, with its ingredients and steps. |  | 200 `Recipe` |  |
| `PUT /api/recipes/:id` | an account | Edit a recipe of the account's own, whoever wrote it. A new version is written by hand, in the language of the request, and its id answered: the plans that hold the old version keep it, and the favourites and favourite sets that named it name the new one. A recipe made by swapping an ingredient stays one, and is still not to be submitted. | `OwnRecipeInput` | 200 `Recipe` | 10 in a minute |
| `DELETE /api/recipes/:id` | an account | Delete a recipe of the account's own. The plans that hold it keep it; a recipe of the shared library cannot be deleted (403). Deleting it again changes nothing. |  | 204 |  |
| `POST /api/recipes/:id/submit` | an account | Put a recipe of one's own before the curators, as a candidate for the library everyone shares. They see what the recipe says and is made of, not who sent it. Repeating the request changes nothing. A recipe made by swapping an ingredient stays its owner's (409). |  | 204 | 10 in a minute |
| `POST /api/recipes/drafts/from-prompt` | an account | Ask a model for a recipe of the account's own, from the choices the request names: the meal, the diet, the cuisine, the energy, the time. There is no text of the user's in the request. The model chooses among the ingredients of the catalogue, the engine works out the nutrition, and the recipe is the account's alone. | `AiDraftRecipeRequest` | 201 `AiDraftRecipeResponse` | 10 in a minute |
| `GET /api/recipes/mine` | an account | The recipes of the account's own, a page at a time: those a model wrote for it, those a substitution left and those written by hand. A deleted one is not among them. | query `PageQuery` | 200 `RecipeSearchPage` |  |
| `POST /api/recipes/preview` | an account | What a serving of a recipe being written would hold, and its allergens and diets. Nothing is stored. | `OwnRecipePreviewRequest` | 200 `OwnRecipePreview` | 60 in a minute |

## review

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `POST /api/review/auth` | anyone | Sign a reviewer in with the reviewers' password and the name they review under. The session is a cookie. | `ReviewerLoginBody` | 204 | 5 in a minute |
| `POST /api/review/auth/logout` | anyone | End the reviewer's session. |  | 204 |  |
| `GET /api/review/drafts/ingredient-names` | a reviewer | The names of ingredients that wait for a review in a language, a page at a time. | query `ReviewQueueQuery` | 200 `IngredientNameReviewSlicePage` |  |
| `GET /api/review/drafts/ingredient-names/:id` | a reviewer | One of those names: the text in the language beside the English. | query `TargetLocaleQuery` | 200 `IngredientNameReviewSlice` |  |
| `PATCH /api/review/drafts/ingredient-names/:id` | a reviewer | Change the text of a name in the language. | `IngredientNameReviewPatchBody`, query `TargetLocaleQuery` | 200 `IngredientNameReviewSlice` |  |
| `POST /api/review/drafts/ingredient-names/:id/approve` | a reviewer | Approve a name in the language. | `ReviewerReasonBody`, query `TargetLocaleQuery` | 201 `IngredientNameReviewSlice` |  |
| `POST /api/review/drafts/ingredient-names/:id/reject` | a reviewer | Reject a name in the language, with a reason. | `ReviewerReasonBody`, query `TargetLocaleQuery` | 201 `IngredientNameReviewSlice` |  |
| `GET /api/review/drafts/recipes` | a reviewer | The recipe drafts that wait for a review in a language, a page at a time. | query `ReviewQueueQuery` | 200 `RecipeReviewSlicePage` |  |
| `GET /api/review/drafts/recipes/:id` | a reviewer | One of those drafts: the text in the language beside the English. | query `TargetLocaleQuery` | 200 `RecipeReviewSlice` |  |
| `PATCH /api/review/drafts/recipes/:id` | a reviewer | Change the text of a recipe draft in the language. | `RecipeReviewPatchBody`, query `TargetLocaleQuery` | 200 `RecipeReviewSlice` |  |
| `POST /api/review/drafts/recipes/:id/approve` | a reviewer | Approve a recipe draft in the language. | `ReviewerReasonBody`, query `TargetLocaleQuery` | 201 `RecipeReviewSlice` |  |
| `POST /api/review/drafts/recipes/:id/reject` | a reviewer | Reject a recipe draft in the language, with a reason. | `ReviewerReasonBody`, query `TargetLocaleQuery` | 201 `RecipeReviewSlice` |  |
| `GET /api/review/session` | anyone | The reviewer's session, or none: what the page asks first, to show the queue or the form to sign in. Answers 200 either way. |  | 200 `ReviewerSessionAnswer` |  |
| `GET /api/review/status` | anyone | Whether reviewers may sign in on this instance, and the languages there are to review. Anyone may ask; the password is no part of the answer. |  | 200 `ReviewStatus` |  |

## shopping-lists

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/shopping-lists` | an account | The shopping lists of a plan, the newest first. | `?planId=` | 200 a list of `ShoppingList` |  |
| `GET /api/shopping-lists/:id` | an account | One shopping list. |  | 200 `ShoppingList` |  |
| `DELETE /api/shopping-lists/:id` | an account | Delete a shopping list. What was obtained for days still ahead goes into the pantry. |  | 204 |  |
| `PATCH /api/shopping-lists/:id/items/:itemId` | an account | Change a row of a list: how much of it is there, what was at home, or its tick. The pantry follows. | `UpdateShoppingItemRequest` | 200 `ShoppingList` |  |
| `POST /api/shopping-lists/:id/proposals` | an account | What the list could do without: rows that one ingredient could stand for, and packs that will be left over. The engine works them out, and a model puts them in order and says a sentence of each when the request asks for one. Nothing is written. Every meal of the list's days may be looked at for it, so the limit is that of making a plan. | `WeighRequest` | 200 `ListProposals` | 20 in a minute |
| `POST /api/shopping-lists/generate` | an account | Make the shopping list of a plan, or of some of its days. The lists of the plan that share a day with it are replaced. | `GenerateShoppingListRequest` | 201 `ShoppingList` |  |

## users/me

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/users/me` | an account | The account: its address, its name and what it has chosen. |  | 200 `SessionUser` |  |
| `DELETE /api/users/me` | an account | Delete the account and everything it holds. Asks for the password. | `DeleteAccountRequest` | 204 | 5 in a minute |
| `PATCH /api/users/me` | an account | Change the account's name, language, look, AI mode or unit of weight. | `UpdateUserSettings` | 200 `SessionUser` |  |
| `POST /api/users/me/email` | an account | Ask for another address: a mail with a link goes to the new one, and the change is made once the link is followed. | `ChangeEmailRequest` | 202 | 5 in a minute |
| `POST /api/users/me/email/resend-verification` | an account | Send the mail that confirms the account's address again. |  | 202 |  |
| `GET /api/users/me/export` | an account | Everything the account holds, as one JSON file (`AccountExportService`). It reads every table the account has rows in, so it is asked for a few times an hour at most, counted against the account; and it is nothing for a cache to keep. |  | 200 a file | 6 in an hour |
| `POST /api/users/me/password` | an account | Change the password. Asks for the one the account has, and ends every session of the account, this one too. | `ChangePasswordRequest` | 204 | 5 in a minute |
| `GET /api/users/me/second-factor` | an account | Whether the account signs in with a second factor, since when, and how many recovery codes it has left. |  | 200 `SecondFactorState` |  |
| `POST /api/users/me/second-factor` | an account | The first code: signing in takes one from now on. Answers with the recovery codes, this once. | `SecondFactorConfirmRequest` | 201 `RecoveryCodes` | 10 in a minute |
| `DELETE /api/users/me/second-factor` | an account | Switch the second factor off. Asks for the password and a code. | `SecondFactorProofRequest` | 204 | 5 in a minute |
| `POST /api/users/me/second-factor/recovery-codes` | an account | New recovery codes in the place of the ones the account had. Answers with them, this once. | `SecondFactorProofRequest` | 200 `RecoveryCodes` | 5 in a minute |
| `POST /api/users/me/second-factor/setup` | an account | A secret to set an authenticator app up with. It counts from the first code on (`POST` here). | `SecondFactorSetupRequest` | 200 `SecondFactorSetup` | 5 in a minute |
| `GET /api/users/me/sessions` | an account | The sessions of the account that are open: where it is signed in. |  | 200 a list of `AccountSession` |  |
| `DELETE /api/users/me/sessions` | an account | Sign out everywhere, this session included. |  | 204 |  |
| `DELETE /api/users/me/sessions/:id` | an account | End one session of the account. |  | 204 |  |

## weights

| Route | Asked by | What it does | Takes | Answers | Limit |
|---|---|---|---|---|---|
| `GET /api/weights` | an account | The weights noted for a profile, the newest first. `?since=` leaves out what is older than a moment: a chart of three months asks for three months. | query `WeightListQuery` | 200 a list of `WeightEntry` |  |
| `POST /api/weights` | an account | Note a weight of a profile for a day. | `CreateWeightEntryRequest` | 201 `WeightEntry` |  |
| `DELETE /api/weights/:id` | an account | Remove a noted weight. |  | 204 |  |
