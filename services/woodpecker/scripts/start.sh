#!/bin/sh
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
for file in server.env agent.env; do
  [ -f "$file" ] || { echo "$file is required; the deploy writes it from the WOODPECKER_* secrets." >&2; exit 1; }
done
docker compose config --quiet
network=$(docker compose config --format json | python3 -c \
  'import json, sys; print(json.load(sys.stdin)["networks"]["proxy"]["name"])')
docker network inspect "$network" >/dev/null 2>&1 || {
  echo "Proxy network '$network' does not exist; set LOGS_PROXY_NETWORK." >&2; exit 1;
}
docker compose pull --quiet
# No --force-recreate: unchanged configuration keeps running builds alive.
if ! docker compose up -d --remove-orphans --wait --wait-timeout 120; then
  docker compose logs --tail=40 >&2
  echo 'Woodpecker did not become healthy.' >&2
  exit 1
fi

# The theme lives in the data volume (the root filesystem is read-only) and is
# read on every request, so copying it needs no restart.
docker compose cp custom.css server:/var/lib/woodpecker/custom.css >/dev/null
address=$(docker compose port server 8000)
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://$address/healthz")
[ "$status" = 204 ] || { echo "Unexpected Woodpecker health status: $status" >&2; exit 1; }
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://$address/api/user")
[ "$status" = 401 ] || {
  echo "Unauthenticated /api/user returned $status; the API is not protected." >&2; exit 1;
}
theme=$(curl --silent --output /dev/null --write-out '%{http_code} %{size_download}' --max-time 5 "http://$address/assets/custom.css")
[ "$theme" = "200 $(wc -c < custom.css | tr -d ' ')" ] || {
  echo "Custom theme is not served as copied: $theme" >&2; exit 1;
}
echo 'OK: Woodpecker server and agent are healthy and the API requires a login.'
printf 'Ready: Woodpecker http://%s (console: http://woodpecker-server:8000)\n' "$address"
