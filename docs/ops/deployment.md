# Deployment

Docker-first and self-host-friendly: local, LAN-only, or cloud. No vendor lock-in.

## Image

There is one image, `diet-app`, built from `infra/docker/Dockerfile`: multi-stage,
Alpine, non-root, with no package manager inside. Every service runs from it and
differs only by its command, so one tag pins the whole application and the web can
never be from a different version than the API it talks to.

| Role | Command |
|---|---|
| API | `node apps/api/dist/main.js` (the image's default) |
| Scheduled-tasks worker | `node apps/api/dist/worker.js` |
| Migrations (`db-init`) | `/app/node_modules/.bin/prisma migrate deploy`, in `/app/apps/api` |
| Web front-end | `node /web/apps/web/server.js` (Next.js standalone output) |

Build context is the repo root. The `release.yml` workflow builds the image on a
`vX.Y.Z` tag of `main` and pushes it to GHCR with provenance + SBOM by its digest
alone; only when the scan of that digest passed does it put the version tags and
`latest` on it and publish the release. It is disabled while the project is in
development. Until then the image is built on demand by the "Snapshot build" workflow
(`docker-snapshot.yml`), which also tags only after the scan: run from `dev` it is
tagged `:dev`, run from `main` `:edge`, each also under its commit
(`:edge-<7-char-sha>`), and an `:edge` build with a high or critical finding is not
tagged at all. Every build brings the OS packages of the image up to date.

## Compose files

| File | Purpose |
|---|---|
| `infra/docker-compose.yml` | Production-like stack: web, api, worker, postgres. |
| `infra/docker-compose.dev.yml` | Just Postgres — run the apps on the host with HMR. |
| `infra/docker-compose.gpu.yml` | Overlay giving Ollama NVIDIA GPU access. |

Profiles gate optional services: `--profile ollama` (local AI), `--profile proxy` (Traefik).

PostgreSQL, Ollama and Traefik are pinned in these files by version and digest, as the
base image of the application is: the digest is what gets pulled, the version says what
it is. To move one, read the version and its digest from the registry
(`docker buildx imagetools inspect postgres:<version>-alpine`) and write both. A new major
of PostgreSQL is more than a new tag: the data has to be dumped from the old server and
restored into the new one.

## Quick start

```bash
sh scripts/init-env.sh          # writes .env with freshly generated secrets
#                                 then set ADMIN_PASSWORD in it
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

> **Why `--env-file .env`?** The compose file lives in `infra/`, so Compose looks
> for its interpolation `.env` in `infra/` — not the repo root. Without the flag,
> every `${VAR:-default}` in the compose file (`WEB_PORT`, `API_PORT`,
> `POSTGRES_*`, `IMAGE_TAG`) silently falls back to its default and any non-default
> override in your root `.env` is ignored. (Runtime secrets still load via
> `env_file:`; this only affects `${...}` placeholders.) See the header comment in
> [`infra/docker-compose.yml`](../../infra/docker-compose.yml) for the full
> explanation.

The `db-init` one-shot service applies pending Prisma migrations before `api`
and `worker` start, then exits. **The curated ingredients and recipes are not
loaded by themselves**: a start only brings the database to the current schema.
Load them on the first run, in the admin panel:

1. Browse to `http://localhost:3000/admin`, sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
2. (Optional) On the host, fetch USDA whole foods:
   `FDC_API_KEY=<key> npm run import:usda` (defaults to **Foundation**, ~330
   generic foods). Writes `data/ingredients.generated.json` — without it only the
   hand-curated baseline (93 ingredients) is available. `FDC_DATA_TYPES` can
   include `SR Legacy` for the full ~7 k corpus, but see
   [data/README.md](../../data/README.md#choosing-fdc_data_types) for why that
   is rarely worth it.
   **Run import** on the admin panel does the same from inside the API
   container, which writes into `data/` on the host as user 1000. Where the
   repository belongs to another user (root on a server, for example), give
   that user the directory first: `chown 1000 data`. The panel says so when it
   cannot write, and asks nothing of the food database until it can. Without
   `FDC_API_KEY` the import uses the public demonstration key, which allows
   only a few requests an hour; when that is used up the panel says when to
   try again.
3. Click **Update Database**. Subsequent edits or re-imports show
   "update available" via a sha256 of `data/*.json` stored in `SeedMeta`.

CLI alternative (the image ships no npm, so the seed runs through its binary):
`docker compose ... exec -w /app/apps/api api /app/node_modules/.bin/tsx prisma/seed.ts`.

Web → `:3000`, API → `:4000/api`, health → `:4000/api/health`.

## Development

```bash
docker compose -f infra/docker-compose.dev.yml up -d   # Postgres
npm install && npm run db:migrate
npm run dev                                            # web + api with HMR
```

Same first-run rule: populate the DB from `/admin` (or run `npm run db:seed`).

## Reverse proxy

`--profile proxy` starts Traefik (`infra/traefik/`), routing `/` → web and `/api` → api on
one entrypoint. For TLS, add a `websecure` entrypoint and a cert resolver. Traefik is
optional — any reverse proxy works; expose only the proxy port publicly.

A request that asks an AI model can take up to 60 seconds before the API answers (see
[AI model recommendations](ai-models.md#limits-on-every-request)). Give the proxy a read
timeout above that — 90 seconds matches the web front-end's own. Traefik has none by
default; nginx stops at 60 seconds unless `proxy_read_timeout` is raised.

### Telling the API who the client is

The API never sees a visitor's own connection: requests reach it from the web server, or
from the reverse proxy. Left alone it therefore takes every visitor for one client. The
visitor's address arrives in the `X-Forwarded-For` header, which the API believes only
when told to, because without a proxy in front anybody can write that header themselves.

1. Put a reverse proxy in front and make sure the app cannot be reached around it. With
   `docker-compose.prod.yml` the web port is bound to `127.0.0.1` for exactly this; with
   `--profile proxy`, publish only Traefik's port.
2. Let the proxy write the header. Traefik and Caddy do so on their own. nginx needs
   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
3. Set `TRUST_PROXY=1` in `.env` and restart the API. With a CDN or a second proxy in
   front of the first, count that one too: `TRUST_PROXY=2`.
4. Sign in to `/admin` through the public address and open **Connection**. "Client
   address" must be your own address. If it is the proxy's, the number is too low or the
   proxy does not write the header; if a page warns that requests are "counted as the
   proxy", `TRUST_PROXY` is not set.

Count only proxies that write the header. The web server is not one: one Traefik or one
nginx in front is `1`, whether it sends `/api` to the API itself or everything to the web
server. A number that is too high is the mistake that matters: the page still shows your
own address, but the API then reads an address further left in the header than any proxy
wrote, and a visitor who writes the header themselves can claim any address. The
Connection page warns when the setting counts more proxies than your request passed.

Never set `TRUST_PROXY` on an instance whose web or API port is reachable directly: a
visitor could then claim any address, and with it somebody else's allowance.

An instance whose `APP_URL` is https has a proxy in front by necessity. If `TRUST_PROXY`
is off there, the API says so in a warning every time it starts.

### Rate limits

Every route is limited, and a request is counted against its sender: the user when it
carries a valid sign-in, otherwise the client's address. A route that tries a credential
is counted by that credential as well, so that guessing at one account never uses up
anybody else's tries.

| Request | Counted against | Limit |
|---|---|---|
| With a valid sign-in | The user | `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW` and route; less on AI routes |
| Without one | The client's address | The same; 10 a minute for sign-up |
| Sign-in | The account and the address together | 10 in 15 minutes |
| | The account, from everywhere together | 50 in 15 minutes |
| | The address, whatever the account ¹ | 30 in 15 minutes |
| Password-reset request | The account the reset is for | 5 in 15 minutes |
| | The address, whatever the account ¹ | 15 in 15 minutes |
| Token refresh, sign-out | The token presented | 10 a minute |
| | The address, whatever the token ¹ | 30 a minute |
| Links from mails | The token presented | 10 a minute |
| | The address, whatever the token ¹ | 10 a minute |
| Changing the password or address, deleting the account | The user | 5 a minute each |

¹ Only with `TRUST_PROXY` set. Without it the API sees one address for everybody, and
counting sign-ins or refreshes against that address would let a handful of requests
keep every user out. So on these routes the address is left out until the API is told
whose word to take for it, and one client can then go through account after account
unhindered. An instance that is open to the internet needs `TRUST_PROXY`.

Wrong passwords for one account never slow down sign-in to another account. With
`TRUST_PROXY` set they do not keep the owner out either: the ten tries are those of the
address that guessed, and the owner sits at another one. Only five addresses guessing
together reach the fifty an account allows from everywhere, which is what stops somebody
with many addresses from guessing without end. Without `TRUST_PROXY` ten wrong passwords
close the account to its owner too, for up to a quarter of an hour.

An IPv6 client is counted as its /64 network: one machine has that many addresses.

No route is left out, the health probe and the public configuration included. The
container's own health check comes from inside the container and has an allowance of its
own. A monitor that reaches the instance through the same proxy as the visitors shares
theirs until `TRUST_PROXY` is set.

What is counted against the address is only as good as the address: without
`TRUST_PROXY` it is one allowance for the whole instance, and sign-ups, for example, stop
for everybody once ten were tried in a minute.

The administrator's and the reviewers' passwords have no account to count attempts
against. After five wrong ones in a row from one address, that address waits 30 seconds
before its next attempt is looked at, then twice as long after every further failure, up
to 15 minutes. Each failure is logged as `failed admin sign-in from <address>`. Without
`TRUST_PROXY` an attacker's failures also make the real administrator wait: one more
reason to set it. These counts, like the limits above, are kept in the memory of each
API process: see [More than one API process](#more-than-one-api-process).

Checking a password costs about a fifth of a second of processor time by design. The
checks run beside the request handling, not in it, and at most 64 wait at once; beyond
that a request is answered `503 SERVER_BUSY`.

### How much an account may hold

What a user can pile up is limited as well, so that no answer of the API grows without
end. The limits are part of the application, not settings.

| What | The most |
|---|---|
| Profiles of an account | 2 |
| Recipes a profile has marked | 500 |
| Favorite sets of a profile | 50 |
| Rows in the pantry of a profile | 1000 |
| Shopping lists of a plan | 10 |
| AI provider configurations of an account | One for each provider |

A request that would go over one is answered `409` with a code that says which. Longer
lists come a page at a time (recipes, plans, the drafts of the admin panel), and three
show only their newest entries: the 1000 newest weights of a profile, the 50 newest unread
notifications, and the 50 sessions of an account that were used last. Signing out
everywhere ends the sessions the list does not show, too.

### What a page may load

Every page is sent with a content security policy that the browser enforces. Only the
application's own scripts run: each carries a value made for that one response, and a
script that got into a page any other way (written into its HTML, in an attribute, from
another site) does not. No script may make code from text. Pictures, fonts and requests
come from the instance's own address only, the page frames nothing and may be framed by
nobody. With `TURNSTILE_ENABLED=true` the frame of Cloudflare's challenge is allowed, and
nothing else of another site.

What this asks of a reverse proxy or a CDN in front:

- **Pass the pages on as they are.** A feature that rewrites the HTML or adds scripts to
  it (Cloudflare's Rocket Loader, an injected analytics or "email protection" script) is
  blocked by the policy, and a page whose own scripts were rewritten stops working. Turn
  such features off for the instance.
- **Do not cache the pages.** The value in the policy and on the scripts belongs to one
  response, and the pages say so themselves (`Cache-Control: private, no-store`): a rule
  that caches HTML all the same serves a page with an old value. The files under
  `/_next/static/` say that they never change and can be cached for as long as you like.
- **Leave the `Content-Security-Policy` header alone.** A second policy added by the
  proxy can only forbid more, and will forbid the application's scripts if it does not
  name their value.

Two things follow from `APP_URL`: an instance whose public address is `https://…` also
tells browsers to keep to https for two years (`Strict-Transport-Security`) and to turn
any http request of a page into https; an instance at an `http://` address sends neither,
since both would break it. The web server reads `APP_URL` and `TURNSTILE_ENABLED` for
this, and nothing else from `.env`: the Compose files hand it those two. If you start the
image's web server some other way, set both in its environment.

When a browser blocks something, it tells the API (`POST /api/csp-reports`), and the API
says so in its log: each kind of violation once when it is first seen, and every ten
minutes how often each was reported.

```
WARN [ContentSecurityPolicy] script-src-elem blocked inline on /login
LOG  [ContentSecurityPolicy] 14 report(s) in the last 10 minutes: 14x script-src-elem blocked inline on /login
```

A line names the directive, what was blocked (a word such as `inline` or `eval`, or the
site it came from) and the page, without its query. `chrome-extension` or `moz-extension`
is a visitor's browser extension and can be ignored. `inline`, or the name of a site you
do not know, on pages that many visitors open means that something adds to the pages on
their way: look at the proxy first. The route takes sixty reports a minute from one
sender and at most thirty kinds of violation in ten minutes are told apart, so nobody can
fill the log through it; what comes beyond is counted or dropped.

### Use without a network

A browser that reaches the instance over https keeps two things, so that a shopping list
can be read in a shop without a signal:

- **The shell of the pages.** The application's service worker (`/sw.js`) keeps the pages
  a browser has opened and the files they are built from, and answers with them when the
  server cannot be reached. A page as the server sends it is the same for everybody, so
  nothing of an account is in what the worker keeps. This is the one place where a page is
  stored although it says `no-store`: the browser's own copy holds the page and its policy
  together, as they were sent.
- **What the account read last.** The plans, the shopping lists and what their pages read
  beside them are kept in the browser's storage under the account's id, and shown when a
  request gets no answer. Nothing can be changed then, except that a row of a shopping
  list can be ticked: the tick is sent when the server is back. Signing out removes all
  of it, and so does another account that signs in on the same browser.

Browsers give a page neither of the two over plain http (an address on the machine itself
is the exception). An instance at an `http://` address in a home network works as it
always did, and has no use without a network. For that, put it behind https.

What this asks of a reverse proxy or a CDN in front: answer `/sw.js` as the web server
answers it, from the instance's own address, and do not keep it for long (a browser asks
for it again to learn of a new version).

## Two-step sign-in

An account can add a second step to signing in, under **Settings**: a six-digit code
from an authenticator app (any app that follows RFC 6238: SHA-1, six digits, thirty
seconds). The administrator can do the same for the panel, on the admin page. Nothing
has to be configured for it.

- **The clock of the server has to be right.** A code is good for about a minute around
  the moment the app shows it. Keep the host on NTP.
- **Wrong codes are counted with the account**, in the database: after five in a row the
  next code waits 30 seconds before it is looked at, then twice as long after every
  further wrong one, up to a day. The count holds across addresses, API processes and
  restarts. Each wrong code is logged as `wrong code for the second factor of <account id>`.
  A recovery code is looked at all the same, so the holder is not kept out by somebody
  else's guessing.
- **An account that lost the app** signs in with one of the ten recovery codes it was
  shown when it switched the second step on. A password reset by mail does not remove
  the second step.
- **An account that lost the app and the recovery codes** turns to you. On the admin
  page, **Two-step sign-in of an account** switches it off for the account of an e-mail
  address; the account then signs in with its password alone and is told so by mail.
  Make sure the person who asks is the holder: afterwards whoever knows the password
  gets in.
- **An administrator who lost the app**: set `ADMIN_SECOND_FACTOR_RESET=true` and restart
  the API. The administrator's second step is removed at start-up and the panel opens
  with the password alone. Set it back to `false` and restart once more: while it is on,
  no second step can be set up, and the start-up log says so.
- The secrets of the apps are encrypted with `DATA_ENCRYPTION_SECRET`, like the e-mail
  addresses. A database restored under another secret cannot check a code.

## Ollama / GPU

```bash
docker compose --env-file .env \
  -f infra/docker-compose.yml -f infra/docker-compose.gpu.yml \
  --profile ollama up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Set `AI_DEFAULT_PROVIDER=ollama` and `OLLAMA_BASE_URL=http://ollama:11434`. GPU mode needs
the NVIDIA Container Toolkit on the host.

## Anti-abuse (Turnstile)

Cloudflare Turnstile is **optional** and **off by default** (`TURNSTILE_ENABLED=false`);
rate limiting protects the auth endpoints regardless. To turn it on, set all three:

```env
TURNSTILE_ENABLED=true
TURNSTILE_SITE_KEY=0x...      # public — served to the browser via GET /api/config
TURNSTILE_SECRET_KEY=0x...    # secret — stays on the server
```

The widget then renders on **Register, Login, and Forgot-password**; the front-end
reads the site key from `/api/config` at runtime, so no web rebuild is needed to
flip it. With `TURNSTILE_ENABLED=true` but the keys missing, verification
fails closed (every submit is rejected).

The web server has to know of the switch as well as the API: the pages' content security
policy allows the challenge's frame only when it is on (see
[What a page may load](#what-a-page-may-load)). With the Compose files both read it from
the same `.env`; restart the web container too when you change it.

## Email (SMTP)

Email is **optional**. "Configured" means **`SMTP_HOST` is set**:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587                 # 465 = implicit TLS; 587/25 = STARTTLS
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=no-reply@your-domain
SMTP_REQUIRE_TLS=true         # false only for a relay on a trusted path
```

The connection to the mail server is encrypted before the password or a mail goes over
it: from the first byte on port 465, by STARTTLS on 587 and 25. A server that does not
offer STARTTLS is not used. `SMTP_REQUIRE_TLS=false` allows an unencrypted connection,
for a relay on the same host or network; the start-up log warns about it.

A mail never holds up or fails the request that causes it. It is handed over and goes
out after the request was answered; the API gives up on a mail server that does not
answer within about ten seconds. A mail that could not be sent is written to the API log
(`… mail was not sent: …`, without the address) and is not tried again: the user asks
for the link again. One address is sent at most 10 mails a day, whoever causes them.

Behaviour switches on whether SMTP is configured:

| Action | SMTP configured | SMTP blank |
|---|---|---|
| Register | account starts **unverified** + a confirmation email is sent | account is **auto-verified** at creation (nothing to verify against) |
| Forgot password | reset link is **emailed**; a "password changed" **notice email** once a new password was set from it | **not available** — the sign-in page has no link and the reset page says so. A request sent straight to the API is still accepted: outside production its link is **logged to the api stdout**, in production nothing is logged |
| Change password (in Settings) | applies immediately + a "password changed" **notice email** | applies immediately, no email |
| **Change email** (in Settings) | confirmation link emailed to the **new** address; change lands on confirm. The address the account has is told when the change is asked for and when it has happened, with the new address shown in part (`m•••@example.com`) | **not available** — the option is hidden |

Changing the account email is the one action gated entirely on SMTP. All confirmation
links expire after 1 hour and work once. A link to reset the password or to confirm a new
address also stops working when another one is asked for, and when the account's password
or address changes in the meantime.

## The worker

The worker is the same image started as `node apps/api/dist/worker.js`. It serves no
requests and opens no port, and needs the same database and the same secrets as the API.
Once when it starts and every hour after that it:

- reminds the profiles that are due to log a weight;
- removes notifications nobody will look at again: read more than 60 days ago, or unread
  for a year;
- removes personal recipes that were deleted, once nothing uses them any more;
- removes the tokens of sessions that have ended, and links and sign-in challenges that
  were used or have expired;
- seals stored addresses and provider keys for the account each belongs to, which finds
  something to do only after a database from before that was done has been restored.

A job that fails is logged as `<job> failed: <reason>`, does not keep the others from
running, and is tried again an hour later.

One worker is enough, and a second one does no harm. Each job holds a lock of the
database's for as long as it runs, so a second worker, or an old one that is still up
while a new one starts, leaves a job to whoever is at it and logs `running elsewhere,
left alone this time`. The lock belongs to a transaction that stays open, and idle, while
the job runs: a database with `idle_in_transaction_session_timeout` set ends a job that
takes longer than that.

## More than one API process

What an instance has to remember is in the database, so several processes of the API can
serve it behind one proxy: the accounts and their sessions, the administrator's and the
reviewers' sign-in, the plans, and where the administrator's background jobs stand (the
catalogue update, the food import, the two generators of drafts). Whichever process is
asked about a job answers the same, and one of them runs it. A job whose process died is
shown as failed three quarters of a minute later and can be started again.

Three things are kept in the memory of each process, and so count once for each:

| What | With N processes |
|---|---|
| The [rate limits](#rate-limits), and the waits after wrong administrator and reviewer passwords | A client whose requests are spread over the processes is allowed up to N times as much |
| The 10 mails a day one address is sent | Up to N times as many |
| The 64 password checks that may wait at once | 64 for each process |

A process that restarts begins its counts anew.

Where that matters, limit requests in the proxy as well, per client address: it is the one
place every request passes (`rateLimit` in Traefik, `limit_req` in nginx, `rate_limit` in
Caddy). The routes that try a credential come first: `/api/auth/login`,
`/api/auth/login/second-factor`, `/api/auth/register`, `/api/auth/password-reset/request`,
`/api/admin/session` and `/api/review/auth`. Or have the proxy send each client address to
the same process every time, which leaves a client facing the counts of one process.

Two more things differ from one process:

- `TRUST_PROXY` counts the proxies between the client and the API. A balancer in front of
  the proxy is one more.
- The data directories are read and written by whichever process handles the request:
  what the local ship mode copies to `INSTANCE_DATA_DIR`, and what a food import leaves in
  `SEED_DATA_DIR`. Give every process the same volume for them.

The worker is not multiplied with the API: see [The worker](#the-worker).

## When a page is slow

The API is measured against a catalogue of 2,000 recipes (`npm run bench`, see
[CONTRIBUTING](../../CONTRIBUTING.md#performance-budgets)). On a small virtual machine
with the database beside it, a plan of four weeks and five meals a day is made in under
half a second there, its shopping list in a tenth of a second, and a page of the recipe
library in a twentieth. An instance whose catalogue is no larger and which takes several
times as long is held up by something outside the application: the disk or the memory of
the database, or a machine that is busy with something else.

To see what the database is asked, set `SLOW_QUERY_MS`, to `50` for a start. The API then
logs every statement that took that many milliseconds or longer:

```
WARN [Database] A statement took 212 ms: SELECT "public"."Recipe"."id", ... WHERE "public"."Recipe"."id" IN ($1,$2)
```

The line holds the statement with its placeholders, never the values that went with them.
Leave the variable unset when the question is answered: with it set, every statement is
timed.

Choosing the recipes of a plan is work of the API process itself. For a plan of four
weeks at that catalogue it holds the process for about a sixth of a second, in which the
other requests of that process wait. [More than one process](#more-than-one-api-process)
lets them be answered meanwhile.

## Production notes

- Set strong `JWT_*` secrets and a 64-hex `AI_KEY_ENCRYPTION_SECRET` (`openssl rand`).
- Persisted volumes: `postgres-data`, `ollama-models`.
- PostgreSQL, the API and the web front-end have health checks; the API's fails when it cannot reach the database. The worker has none: Docker restarts it when its process exits.
- Run `db:migrate` (not `migrate dev`) on deploy; back up the Postgres volume.
- A database of your own in the place of the Compose one has to be a PostgreSQL that is built with ICU, as the official images are: lists of recipes and ingredients are sorted by the names they show, in the alphabet of the reader's language (`en-x-icu`, `pl-x-icu`).
- Bind published ports to a private interface in LAN-only deployments.

### Whose day it is

Which plan is under way, and which of its days have passed, goes by the day it
is for the user, not for the server: late in the evening the two differ. The
web says which day it is with every request (the header `X-Client-Date`), and
the API takes it when it is the server's own day in UTC, the day before or the
day after; any other is refused with 400. A client that sends none is given
the server's day. So the server's clock has to be right to the day, which NTP
sees to.

### Server clock

Two clocks tell an instance the time, and both have to be right:

- **The API's.** When a session ends and how long a link from a mail is good for are
  worked out by the API: it writes the moment something ends, and compares it with its
  own clock when the session or the link is used.
- **The database's.** The monthly AI allowance is counted over the last thirty days as
  the database's `NOW()` has them, the same for every process of the API.

In the Compose stack both containers take the time from the host, so what it takes is a
host that keeps time (`systemd-timesyncd`, `chrony`). With the database on another
machine, both machines have to. Every moment is stored in UTC: leave `TZ` unset on the
`postgres` service. The web application shows a time in the zone of the browser.
