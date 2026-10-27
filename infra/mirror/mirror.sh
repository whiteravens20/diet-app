#!/bin/sh
# Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
#
# The `mirror` service of the Compose files: the instance's own files (its
# library of recipes, the names of ingredients it gave and the version that
# wrote them), copied once an hour into a git repository of the operator's,
# with a commit when something changed, pushed with a deploy key. The release's
# Compose file carries this script in the `entrypoint` of its `mirror` service,
# so that it stays the one file an operator downloads; a test holds the two to
# each other.
#
# It reads the instance's files and the key, and writes only the clone of the
# repository and the host key of the git server, taken on the first connection
# and held to after it. A repository that holds files of something else is
# refused: a wrong address would otherwise have them deleted by the copy.
set -u

: "${MIRROR_REPO:?set MIRROR_REPO in .env: the SSH address of the repository the copy goes to}"
: "${MIRROR_NAME:?set MIRROR_NAME in .env: the name of this instance, which the commits are made by}"
FILES=${MIRROR_FILES:-/instance}
STATE=${MIRROR_STATE:-/state}
KEY=${MIRROR_KEY:-/key}
EVERY=${MIRROR_EVERY:-3600}
TREE=$STATE/tree
WHO=$MIRROR_NAME-mirror

export HOME="$STATE"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$STATE/known_hosts -o StrictHostKeyChecking=accept-new"
export GIT_AUTHOR_NAME="$WHO" GIT_COMMITTER_NAME="$WHO"
export GIT_AUTHOR_EMAIL="$WHO@diet-app.invalid" GIT_COMMITTER_EMAIL="$WHO@diet-app.invalid"

say() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# The clone, made in the first round. An empty repository is taken, and so is
# one with nothing but a README, or one this copy has written to before.
clone() {
  [ -d "$TREE/.git" ] && return 0
  rm -rf "$TREE"
  if ! git -c init.defaultBranch=main clone -q "$MIRROR_REPO" "$TREE" 2>"$STATE/clone.log"; then
    say "could not clone $MIRROR_REPO: $(tail -n 1 "$STATE/clone.log")"
    return 1
  fi
  others=$(find "$TREE" -mindepth 1 -maxdepth 1 ! -name .git ! -name README.md | head -n 1)
  if [ -n "$others" ] && ! head -n 1 "$TREE/README.md" 2>/dev/null | grep -q '^# Diet App instance files'; then
    say "$MIRROR_REPO holds files of something else, $(basename "$others") among them: give the copy an empty repository of its own"
    rm -rf "$TREE"
    return 1
  fi
}

# What the repository says of itself, written once: the operator may change it,
# and the copy leaves it alone after that.
readme() {
  [ -f "$TREE/README.md" ] && return 0
  cat >"$TREE/README.md" <<EOF
# Diet App instance files: $MIRROR_NAME

The files the Diet App instance "$MIRROR_NAME" keeps in its directory of its own
files, copied here by its \`mirror\` service so that they outlive the server.

- \`manifest.json\`: the version of the application that wrote the files, and
  how many recipes and names they hold.
- \`recipes/library.json\`: every recipe of the instance's own library, by
  slug, with its lines in their order.
- \`ingredient-overrides.json\`: the names of ingredients the instance gave,
  without those the catalogue's own data gives as they are.

The instance writes these files from its database after every ship into it,
every restore and every update of the catalogue. Once an hour the service copies
them here, and commits as \`$WHO\` only when something changed. A file
removed from the instance is removed here too. This README is the one file the
copy leaves alone.

## Restoring

1. Copy the files into the \`instance-data\` volume of the instance.
2. Start the stack and choose **Update database** in the admin panel, which
   loads the catalogue's own data that the instance's recipes are made of.
3. In the curation card, under "This instance's own files", choose **Restore
   from these files**.

A restore refuses files that a newer version of the application wrote, as
\`manifest.json\` says: update the application first.
EOF
}

# The repository as it is now: its history is the repository's, the files are
# the instance's. An operator's change of the README is taken in, and a commit
# an earlier round could not push is made again from the files.
catch_up() {
  if ! git -C "$TREE" fetch -q origin 2>"$STATE/fetch.log"; then
    say "could not reach $MIRROR_REPO: $(tail -n 1 "$STATE/fetch.log")"
    return 1
  fi
  branch=$(git -C "$TREE" symbolic-ref --short HEAD)
  if git -C "$TREE" rev-parse -q --verify "origin/$branch" >/dev/null; then
    git -C "$TREE" reset -q --hard "origin/$branch"
  fi
}

round() {
  clone || return 1
  catch_up || return 1
  find "$TREE" -mindepth 1 -maxdepth 1 ! -name .git ! -name README.md -exec rm -rf {} +
  cp -R "$FILES/." "$TREE/"
  # A file the instance is in the middle of writing is not one of its files yet.
  find "$TREE" -name '*.writing' -exec rm -f {} +
  readme
  git -C "$TREE" add -A
  git -C "$TREE" diff --cached --quiet && return 0
  git -C "$TREE" commit -q -m "Instance files of $(date -u '+%Y-%m-%d %H:%M') UTC"
  if git -C "$TREE" push -q origin HEAD 2>"$STATE/push.log"; then
    say "pushed a commit to $MIRROR_REPO"
  else
    say "could not push to $MIRROR_REPO: $(tail -n 1 "$STATE/push.log")"
  fi
}

while :; do
  round
  [ "${MIRROR_ONCE:-}" = 1 ] && exit 0
  sleep "$EVERY"
done
