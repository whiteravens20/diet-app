# Curation queue: shipping, backup and moving

How approved drafts leave the curation queue (`/admin`, the curation card) and
where they end up. A mode is picked per ship; an instance may use one today and
another next month. What is written has the same shape in every mode: the shape
of the catalogue's data files.

## The three modes

| Mode | What happens | Needs |
|---|---|---|
| `local` (the default) | The drafts become rows of this instance at once, and are copied to the instance's data directory. | Nothing. |
| `bundle` | The panel is given a file to save; you put it into a repository's `data/` by hand. | Nothing. |
| `upstream-pr` | The file is committed on a branch of a git checkout, pushed, and offered as a pull request. | A checkout with `git` and `gh`, a token, and the mode switched on. |

The catalogue's own data (`data/recipes.json`, `data/recipes/*.json`,
`data/ingredients*.json`, `data/ingredient-overrides.json`) comes from the
repository and is read by every **Update Database**. What ships into the
instance in `local` mode lives beside it and is left alone by an update.

## What every ship holds a draft to

Whichever way it ships, an approved draft is checked once more:

- It passes the rules for recipes: plain text within the length limits, a slug,
  sensible servings, times and quantities. A draft approved before a rule
  existed does not ship until it is edited.
- Its ingredients are ones the catalogue has now.
- Its figures have not moved since it was reviewed: the energy of a serving, the
  allergens and the diets are worked out again from today's ingredient table,
  and a draft whose figures changed goes back to you. Save it again in the
  editor and have it approved with the new figures.
- It does not take the place of another recipe: no other recipe has its slug,
  no other shared recipe has its English title, and none is made of the same
  ingredients in the same amounts for the same meals and servings.

A draft that fails stays in the queue, approved, and the panel names it by its
slug with the reason. The slug of a draft can be changed from its row without
sending it back to review; a title is text and goes through review again.

## A language a recipe lacks

"Fill a missing language" in the curation card asks the instance's model for
the text of recipes in a language they do not have, and puts the answers into
the queue. It changes nothing a user sees: the text is approved like any other,
and ships like any other.

- A draft that waits in the queue gets the language added to it. It then waits
  for that language to be reviewed; the reviews its other languages have stand.
- A recipe this instance shipped gets a draft of its own: the recipe as it is,
  with the new text beside its English. English is in that draft so that the
  administrator passes it on like any draft. Shipped into the instance (`local`),
  it gives the recipe the new language and writes nothing else of it. If the
  recipe has changed since the draft was made, the draft does not ship: reject
  it and fill the language again.
- Such a draft does not go into a bundle or a pull request, which hold whole
  recipes; the panel names it with the reason.
- The recipes of the catalogue's own data are left alone. Their text is written
  by hand in the repository's data files.
- The names of ingredients are not part of this run. An imported ingredient
  gets its name in each language from "Generate names".

### `local`

- A recipe draft becomes a shared recipe of this instance (`origin: curated`),
  with its text stored as approved by people. A draft of an ingredient's name
  becomes that ingredient's name in the languages the draft was reviewed in.
  An update of the catalogue rewrites neither.
- Promoting a recipe users made is the same thing for one draft.
- Each draft ships on its own. One that is being edited or reviewed at that
  moment is read as the edit left it, and ships only if it is still approved.
- What shipped is copied to the instance's data directory (`INSTANCE_DATA_DIR`):
  recipes as `recipes/ship-<time>.json`, names merged into
  `ingredient-overrides.json`. The ship does not fail when the copy cannot be
  written; the panel says so, and warns as long as the API cannot write there.

### `bundle`

- The approved drafts come back as a file, which the panel saves: for recipes a
  batch to put into `data/recipes/` under the name it comes with, for names an
  `ingredient-overrides.json` to merge into `data/ingredient-overrides.json`.
  Nothing is kept on the server and there is no download link: the file is
  given to whoever asks with the administrator's credentials.
- "Mark shipped" is a separate step. Making or saving a bundle changes no
  draft, so a download taken by mistake changes nothing.
- The recipes are not in this instance until the repository you committed the
  file to is the one this instance is built from, and its database is updated.

### `upstream-pr`

- Runs `git` and `gh` in the checkout the API was started from: it checks out
  `drafts/<kind>/<batch>-<stamp>` from `SHIP_UPSTREAM_BASE_BRANCH` of
  `SHIP_UPSTREAM_REMOTE`, writes the batch into `data/recipes/` (or merges the
  names into `data/ingredient-overrides.json`), commits that one file, pushes
  the branch and opens a pull request with `gh`. Only then are the drafts
  marked as shipped, with the address of the pull request. A draft that was
  edited while the branch was pushed is not marked.
- **The published container image cannot use this mode**: it holds no git
  checkout and neither tool. It is for an instance started from a clone of a
  repository, on a machine that has `git` and `gh`.
- The remote is never the project's own repository
  (`whiteravens20/diet-app`): text a model wrote is not pushed there from any
  instance. Point `SHIP_UPSTREAM_REMOTE` at a fork or a private mirror.
- Like a bundle, it writes nothing into this instance's own tables.

The mode is off unless `SHIP_UPSTREAM_ENABLED=true`. When it cannot run, the
panel says why, and a request answers `409` with the same code:

| Code | Meaning |
|---|---|
| `SHIP_UPSTREAM_DISABLED` | `SHIP_UPSTREAM_ENABLED` is not `true`. |
| `SHIP_UPSTREAM_NO_TOKEN` | `SHIP_UPSTREAM_GH_TOKEN` is empty. |
| `GH_MODE_UNAVAILABLE` | The `gh` tool is not installed. |
| `SHIP_REPO_ROOT_NOT_FOUND` | The API does not run inside a git checkout. |
| `SHIP_UPSTREAM_BLOCKED_CANONICAL` | The remote is the project's own repository. |
| `GIT_FAILED`, `GH_PR_CREATE_FAILED` | A command failed; the drafts stay approved. |

## Backing up what the instance added

Two places hold what `local` ships added: the database, and the instance's
data directory. Back up both.

- With the Compose files the directory is the named volume `instance-data`.
  Copy it out with
  `docker run --rm -v diet-app_instance-data:/d alpine tar -C /d -cf - . > instance-data.tar`.
- The names of ingredients can also be saved from the panel at any time
  ("current overrides"): that file is built from the database, not from the
  directory.
- The directory is yours. Keeping it in a private git repository of your own
  is a plain `git init` inside it; the application neither knows nor minds.

## Moving to a new server

Moving the database (`pg_dump` on the old server, restore on the new one)
carries everything, and is the way to move an instance that has users.

To carry only what the instance added to its catalogue, without the old
database:

1. Copy the instance's data directory to the new server (for Compose: into the
   `instance-data` volume).
2. Start the stack and run **Update Database** in the panel. That loads the
   catalogue's own data, which the instance's recipes are made of.
3. In the curation card, under "This instance's own files", choose **Restore
   from these files**.

The restore reads `recipes/*.json` in the order of their names and
`ingredient-overrides.json`. A recipe the library does not have is added; one
it has under the same slug is written over from its file and keeps its id. It
can be run again at any time, also on the instance that wrote the files, for
example after correcting a file by hand.

A file is trusted no more than a draft. A recipe that breaks a rule, uses an
ingredient the catalogue does not have, or would take the place of another
recipe is left out, and the panel lists it with its file and the reason. A
slug that a recipe of the catalogue's own data now uses stays with that recipe.

## Pulling the names of ingredients from a repository

The reverse of shipping names: the panel fetches an
`ingredient-overrides.json` and stores its names as approved by people.

- The source is `owner/repo` or `owner/repo@branch` on GitHub, or the full
  address of the file on any host.
- Only public addresses are fetched from. To pull from a server on your own
  network, name its host in `OVERRIDES_PULL_ALLOWED_HOSTS`. A redirect is not
  followed, and a file over 2 MB is not read.
- A name that breaks a rule for names is refused, a name for an ingredient the
  catalogue does not have is skipped, and the panel lists both.
- `OVERRIDES_PULL_TOKEN` is sent to GitHub's hosts and to no other.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `INSTANCE_DATA_DIR` | `instance-data` | Where `local` ships copy what they shipped, and what a restore reads. Keep it on a volume. |
| `SHIP_UPSTREAM_ENABLED` | `false` | Switches the `upstream-pr` mode on. |
| `SHIP_UPSTREAM_REMOTE` | `origin` | The git remote the branch is pushed to. Never the project's own repository. |
| `SHIP_UPSTREAM_BASE_BRANCH` | `main` | The branch the pull request is opened against. |
| `SHIP_UPSTREAM_GH_TOKEN` | — | The token `gh` pushes and opens the pull request with. Handed to `gh` through its environment. |
| `SHIP_UPSTREAM_GIT_AUTHOR_NAME` / `SHIP_UPSTREAM_GIT_AUTHOR_EMAIL` | — | Author of the commit. Without them git's own configuration decides. |
| `OVERRIDES_PULL_SOURCE` | `whiteravens20/diet-app` | The source the panel offers for a pull of names. |
| `OVERRIDES_PULL_TOKEN` | `SHIP_UPSTREAM_GH_TOKEN` | Token for a private GitHub repository. |
| `OVERRIDES_PULL_ALLOWED_HOSTS` | — | Hosts (`host` or `host:port`, comma-separated) a pull may fetch from although their address is not public. |

`bundle` reads no setting. `local` reads only `INSTANCE_DATA_DIR`.

## Worth remembering

- **The engine owns the figures.** No ship stores nutrition, allergens or diets
  a model or a file claimed: they are worked out from the ingredients, at the
  ship and again at every update of the catalogue.
- **An update of the catalogue leaves what the instance added in place.** It
  rewrites the rows that came from `data/`. Of a recipe shipped locally it only
  works the figures out again, and a name approved by people stays as it is.
  One case settles itself: when the data starts to use the slug of a recipe
  the instance added, the same recipe (made the same way) becomes the data's
  and keeps its id and its approved text; a different one keeps its place in
  the library and gives the slug up.
- **Nothing ships twice.** A shipped draft is closed, and a draft whose recipe
  the library already has is held back.
