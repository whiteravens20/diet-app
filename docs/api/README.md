# The contract of the API

What a client of the API builds on: the Android application, a script, another front end.

| Where | What it is |
|---|---|
| [`openapi.json`](openapi.json) | An OpenAPI 3.1 description: every route with who may ask it, its limit, what it takes and what it answers with, and every schema in full. |
| [`routes.md`](routes.md) | The same routes as a list to read. |
| [`errors.md`](errors.md) | Every code a request is refused with, the status it comes with, and its sentence in each language. |
| [`apps/web/messages/`](../../apps/web/messages/) | The message catalogue: one file a language, with the same keys in each. A client that speaks a language shows the texts of that file. |
| [`packages/shared/`](../../packages/shared/) | The schemas themselves (Zod, with their TypeScript types), as the API checks requests with them and the web application reads answers with them. |

## What holds

- **The three files here are written from the code**, by `npm run contract`: the routes from the controllers, the schemas from `packages/shared`, the codes from the source and the catalogue. A test fails when a file is not what the command writes, so a route, a schema or a text that changes shows as a change of these files in the same commit.
- **Every answer is checked.** A route declares the schema it answers with, and the integration tests hold every answer of every route to it: one the schema refuses, a field the schema does not name, and a field it names that is missing each fail the test in which they appear.
- **Every request is checked before a handler sees it**: a body, a query string and a value in a path each go through a schema, and what a client may send has an upper bound.
- **The routes the running application answers are the routes listed**, no more and no fewer: a test compares the two.
- **Every code has a sentence in every language**, and the languages have the same keys, the same arguments and the same tags.

## Asking

- **A session.** `POST /api/auth/login` answers with an access token, good for a quarter of an hour, and a refresh token. The access token goes with every request as `Authorization: Bearer <token>`; `POST /api/auth/refresh` gives a new pair for the refresh token, which is good once. A browser asks with the header `X-Session-Transport: cookie` and gets its refresh token as a cookie no script can read, never in an answer. An account with a second factor is answered with a challenge first (`POST /api/auth/login/second-factor`).
- **A client that keeps its own tokens** (an app on a phone, a script) follows four rules, as the web application does with its cookie:
  - It asks for a new access token only when a request is answered 401 with `UNAUTHORIZED` or `INVALID_ACCESS_TOKEN`. Another 401, such as `INVALID_PASSWORD` for a wrong current password, is about the request, and asking again with a new token would send it twice.
  - It refreshes once for every request that met the same expired token. A refresh token used a second time within ten seconds of its first use is answered 409 `SESSION_JUST_REFRESHED`: the pair the first refresh got is the one to go on with. Used again later, it ends the session.
  - Only a refresh answered 401 (`INVALID_REFRESH`) ends the session. A refresh answered with anything else, a 409, a 429, a 5xx or nothing at all, says nothing about the tokens: the client keeps them and tries again later.
  - It names itself at the start of `User-Agent`, as `DietApp-Android/1.0 (Android 15)`: the name before the first slash, with the system where the header names one, is what the account's list of sessions (`GET /api/users/me/sessions`) calls the session.

  A refresh token is good for `refreshExpiresIn` seconds of the sign-in answer (30 days unless the instance sets another), a session for at most 90 days however often it is refreshed (`JWT_SESSION_TTL`), and `POST /api/auth/logout` ends it.
- **The language.** `Accept-Language` says in which language names and texts are answered; English without it.
- **The day.** `X-Client-Date` says which day it is for the user, as `2026-03-01`: which plan is under way and which days have passed goes by it. The API takes it when it is the server's day, the one before or the one after.
- **A refusal** is an `ApiError`: `statusCode`, a code in `error`, an English sentence in `message`, `issues` where a request failed its schema (`VALIDATION_FAILED`), and `details` where the code has more to say. What a person is shown is `errors.<code>` of their language.
- **Limits.** A route's own limit is in the list of routes and as `x-rate-limit` in the description; everything else is under the general limit of the instance. A request over a limit is answered with 429 and, where the wait is known, `Retry-After`.

## Looking at it

With `SWAGGER_ENABLED=true` an instance shows `openapi.json` at `/api/docs` and serves it at `/api/docs-json`. It is on in development and off in production unless switched on.

The version in the description is the version of the application. Until 1.0.0 the contract changes without a way to keep asking the old way: a change is a change of the files here.
