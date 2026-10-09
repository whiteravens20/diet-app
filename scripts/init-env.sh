#!/bin/sh
# Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
#
# Creates `.env` from `.env.example` with freshly generated secrets.
#
# The template ships its secrets blank and the API refuses to start without
# random ones, so a new install cannot run on values that are public knowledge.
# An existing `.env` is never touched: its DATA_ENCRYPTION_SECRET is what makes
# the stored accounts readable.
#
# Run: sh scripts/init-env.sh
set -eu

cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo ".env already exists; leaving it as it is." >&2
  exit 1
fi

# 32 random bytes as 64 hex characters.
secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

umask 077
sed \
  -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(secret)|" \
  -e "s|^AI_KEY_ENCRYPTION_SECRET=.*|AI_KEY_ENCRYPTION_SECRET=$(secret)|" \
  -e "s|^DATA_ENCRYPTION_SECRET=.*|DATA_ENCRYPTION_SECRET=$(secret)|" \
  .env.example > .env

echo "Wrote .env with fresh secrets."
echo "Next: set ADMIN_PASSWORD in .env to enable the admin panel, and back up DATA_ENCRYPTION_SECRET with your database."
