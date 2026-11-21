#!/bin/sh
# Starts every service in this release. activate.sh calls this entrypoint for
# new releases and for rollbacks, so it must stay at scripts/start.sh.
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

./services/logs/scripts/start.sh

# Meilisearch is optional until its master key is configured (deploy writes
# services/meilisearch/meilisearch.env only when the secret exists).
if [ -f services/meilisearch/meilisearch.env ]; then
  ./services/meilisearch/scripts/start.sh
else
  echo 'Meilisearch skipped: services/meilisearch/meilisearch.env is absent.'
fi

# Woodpecker CI is optional until its GitHub OAuth app and agent secret are
# configured (deploy writes services/woodpecker/server.env only then).
if [ -f services/woodpecker/server.env ]; then
  ./services/woodpecker/scripts/start.sh
else
  echo 'Woodpecker skipped: services/woodpecker/server.env is absent.'
fi
