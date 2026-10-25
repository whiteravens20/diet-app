# Curation queue: shipping, backup and moving

How approved drafts leave the curation queue (`/admin`, the curation card) and
where they end up. A mode is picked per ship; an instance may use one today and
another next month. What is written has the same shape in every mode: the shape
of the catalogue's data files.

## The two modes

| Mode                  | What happens                                                                                      | Needs    |
| --------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `local` (the default) | The drafts become rows of this instance at once, and are copied to the instance's data directory. | Nothing. |
| `bundle`              | The panel is given a file to save; you put it into a repository's `data/` by hand.                | Nothing. |

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

## Recipes from elsewhere

"Recipes from elsewhere" in the curation card takes recipes in from a document
you have: one recipe or several written as schema.org `Recipe`, which is the
JSON a recipe page carries and the shape many tools save. The instance fetches
nothing and asks no model; it reads what you paste or load from a file.

A recipe is taken when all of it can be answered for:

- It has a name, instructions, and a list of ingredients.
- Every line of that list is an amount of an ingredient the catalogue has. An
  amount is a number (a fraction counts, a range does not) in grams, kilograms,
  ounces, pounds, millilitres, litres, teaspoons, tablespoons, cups or fluid
  ounces, or a count of pieces. The ingredient is found by the catalogue's own
  name for it or by a name you wrote down in `data/import-aliases.json` (see
  [`data/README.md`](../../data/README.md)); it is matched in full, never by
  resemblance.
- It says how many servings it makes and gives a preparation or a cooking time.
- It is filed under a meal the app knows (breakfast, lunch, dinner, snack and
  their like), or you named the meals for the import.
- It names its licence, or you named one for the import. **The licence is yours
  to answer for.** The instance records what you state and shows it with the
  recipe; it cannot check that the recipe may be passed on.

A recipe that is taken becomes a draft in English, with where it is from. Its
figures are the engine's, worked out from the catalogue. It is reviewed and
shipped like any other draft, gets its other languages from "Fill a missing
language", and carries its source into the library and into a bundle. Whoever
reads the recipe is told where it is from and under which licence.

A recipe that is not taken never reaches the queue. The import names every
reason, and keeps the refusals (the latest five hundred) under "What earlier
imports refused", so that you can write down another name for an ingredient,
or give a line its amount, and send the document again. "Look first" says what
would come of a document and writes nothing.

One import looks at the first hundred recipes of a document, and takes a
document of about 90 kB. Of one that holds more recipes it says how many were
left: send those in another document. A larger document is not sent at all:
split it. A recipe the library or the queue already has, by its title or by
what it is made of, is refused like any other draft would be at shipping.

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
- Such a draft does not go into a bundle, which holds whole recipes; the panel
  names it with the reason.
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

| Variable                | Default                        | Purpose                                                                                    |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `INSTANCE_DATA_DIR`     | `instance-data`                | Where `local` ships copy what they shipped, and what a restore reads. Keep it on a volume. |
| `OVERRIDES_PULL_SOURCE` | `whiteravens20/diet-app`       | The source the panel offers for a pull of names.                                           |
| `OVERRIDES_PULL_TOKEN`  | `OVERRIDES_PULL_ALLOWED_HOSTS` | —                                                                                          | Hosts (`host` or `host:port`, comma-separated) a pull may fetch from although their address is not public. |

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
