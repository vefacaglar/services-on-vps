#!/bin/sh
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
[ -f meilisearch.env ] || { echo 'meilisearch.env with MEILI_MASTER_KEY is required.' >&2; exit 1; }
docker compose config --quiet
network=$(docker compose config --format json | python3 -c \
  'import json, sys; print(json.load(sys.stdin)["networks"]["proxy"]["name"])')
docker network inspect "$network" >/dev/null 2>&1 || {
  echo "Proxy network '$network' does not exist; set LOGS_PROXY_NETWORK." >&2; exit 1;
}
docker compose pull --quiet
# No --force-recreate: unchanged configuration keeps the running container.
if ! docker compose up -d --remove-orphans --wait --wait-timeout 120; then
  docker compose logs --tail=40 >&2
  echo 'Meilisearch did not become healthy.' >&2
  exit 1
fi

address=$(docker compose port meilisearch 7700)
health=$(curl --fail --silent --show-error --max-time 5 "http://$address/health")
printf '%s' "$health" | grep -Fq '"status":"available"' || {
  echo "Unexpected Meilisearch health response: $health" >&2; exit 1;
}
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://$address/indexes")
[ "$status" = 401 ] || {
  echo "Unauthenticated /indexes returned $status; the master key is not enforced." >&2; exit 1;
}
echo 'OK: Meilisearch is available and requires an API key.'
printf 'Ready: Meilisearch http://%s (apps: http://meilisearch:7700)\n' "$address"
