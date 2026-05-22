# API Design

REST, JSON, prefixed `/api`. Every request/response shape is a Zod schema in
[`packages/shared`](../../packages/shared) — the **contract**. The interactive OpenAPI
spec is served at `/api/docs` (JSON at `/api/docs-json`).

## Conventions

- **Auth** — `Authorization: Bearer <accessToken>`. Access tokens are short-lived;
  refresh tokens rotate. A 401 from the web client triggers one transparent refresh.
- **Errors** — uniform envelope (`ApiError`): `{ statusCode, error, message, issues? }`.
  `error` is a stable machine code (e.g. `AUTH_INVALID_CREDENTIALS`).
- **Validation** — bodies validated by `ZodValidationPipe`; failures return 400 with
  field-level `issues`.
- **Ownership** — every profile/plan/list route is scoped to the authenticated user;
  cross-user access returns 403.
- **Rate limiting** — global per-IP throttle; stricter on `auth/*` and plan generation.

## Endpoints

### Auth — `/api/auth`
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/register` | `RegisterRequest` | Returns `AuthResponse`. |
| POST | `/login` | `LoginRequest` | Returns `AuthResponse`. |
| POST | `/refresh` | `RefreshRequest` | Rotates the refresh token. |
| POST | `/logout` | `RefreshRequest` | 204; revokes the refresh token. |
| POST | `/password-reset/request` | `PasswordResetRequest` | 202; never reveals account existence. |
| POST | `/password-reset/confirm` | `PasswordResetConfirm` | 204; invalidates all sessions. |

### Profiles — `/api/profiles` (auth)
| Method | Path | Notes |
|---|---|---|
| GET | `/` | List the user's profiles. |
| POST | `/` | Create — body `ProfileInput`. |
| GET | `/:id` | Get one. |
| PUT | `/:id` | Update — body `ProfileInput`. |
| DELETE | `/:id` | 204. |
| GET | `/:id/calories` | Deterministic `CalorieCalculation`. |

### Recipes — `/api/recipes` (auth)
| GET | `/?search=&dietType=&mealType=&maxCalories=&maxPrepMinutes=&difficulty=` | Filtered list. |
| GET | `/:id` | Recipe detail. |

### Meal plans — `/api/meal-plans` (auth)
| GET | `/?profileId=` | List plans for a profile. |
| GET | `/:id` | Full plan. |
| POST | `/generate` | `GeneratePlanRequest` → `MealPlan`. Rate-limited. |
| POST | `/swap-meal` | `SwapMealRequest` → updated `MealPlan`. |
| POST | `/swap-ingredient/preview` | `SwapIngredientRequest` → `SwapPreview` (delta). |

### Favorites — `/api/favorites` (auth)
| GET | `/?profileId=` · POST `/` · DELETE `/:profileId/:recipeId` |

### Shopping lists — `/api/shopping-lists` (auth)
| POST | `/generate` | `GenerateShoppingListRequest` → `ShoppingList`. |
| GET | `/:id` · PATCH `/:id/items/:itemId` (`UpdateShoppingItemRequest`) |

### AI providers — `/api/ai/providers` (auth)
| GET | `/` | List configs (keys never returned — `hasKey` only). |
| PUT | `/` | Upsert — `AiProviderConfigInput`; key encrypted on write. |
| DELETE | `/:id` | 204. |

### Health — `/api/health`
Unauthenticated. Returns `{ status, db, time }` for Docker/Traefik probes.

## Contract evolution

Changing a schema in `packages/shared` is a contract change. The Android repo mirrors
these schemas (`docs/contracts/`) — coordinate breaking changes across both repos and
bump deliberately.
