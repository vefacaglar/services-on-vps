#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VPS_HOST:?Set VPS_HOST}"
: "${VPS_USER:?Set VPS_USER}"
: "${VPS_SSH_KEY:?Set VPS_SSH_KEY}"
: "${VPS_KNOWN_HOSTS:?Set VPS_KNOWN_HOSTS}"
: "${DEPLOY_ID:?Set DEPLOY_ID}"
VPS_PORT=${VPS_PORT:-22}
VPS_DEPLOY_DIR=${VPS_DEPLOY_DIR:-/opt/logs-on-vps}

[[ $VPS_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid VPS_HOST' >&2; exit 1; }
[[ $VPS_USER =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid VPS_USER' >&2; exit 1; }
if ! [[ $VPS_PORT =~ ^[0-9]{1,5}$ ]] || (( 10#$VPS_PORT < 1 || 10#$VPS_PORT > 65535 )); then
  echo 'Invalid VPS_PORT' >&2; exit 1
fi
[[ $VPS_DEPLOY_DIR =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid VPS_DEPLOY_DIR; use an absolute path without spaces or dots' >&2; exit 1; }
[[ $DEPLOY_ID =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid DEPLOY_ID' >&2; exit 1; }

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$work_dir"
printf '%s\n' "$VPS_SSH_KEY" > "$work_dir/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$work_dir/known_hosts"
chmod 600 "$work_dir/key" "$work_dir/known_hosts"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS

ssh_options=(
  -i "$work_dir/key" -p "$VPS_PORT"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$work_dir/known_hosts"
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
)
target="$VPS_USER@$VPS_HOST"
release="$VPS_DEPLOY_DIR/releases/$DEPLOY_ID"

# Generated secrets land in the same paths they take inside the release.
# prepare-browser.py also copies MEILI_MASTER_KEY, POSTGRES_URL (or the older
# POSTGRES_READONLY_URL) and the POSTGRES_WRITE_ENABLED switch (when set) into
# the 0600 browser.env for the console's Meilisearch and PostgreSQL views.
stage="$work_dir/stage"
python3 scripts/prepare-browser.py "$stage/services/logs"
unset LOGS_UI_PASSWORD LOGS_UI_USERNAME POSTGRES_URL POSTGRES_READONLY_URL POSTGRES_WRITE_ENABLED
python3 scripts/prepare-meilisearch.py "$stage/services/meilisearch"
unset MEILI_MASTER_KEY

# Explicit allowlist: .env, SSH keys and local files never travel.
logs=services/logs
bundle_paths=(README.md scripts docs)
bundle_paths+=("$logs/compose.yml" "$logs/.env.example" "$logs/.dockerignore" "$logs/README.md")
bundle_paths+=("$logs/vector" "$logs/scripts" "$logs/deploy" "$logs/console")
bundle_paths+=("$logs/client/package.json" "$logs/client/package-lock.json" "$logs/client/tsconfig.json")
bundle_paths+=("$logs/client/vite.config.ts" "$logs/client/index.html" "$logs/client/src" "$logs/client/public")
bundle_paths+=(services/meilisearch/compose.yml services/meilisearch/.env.example)
bundle_paths+=(services/meilisearch/README.md services/meilisearch/scripts)
generated=()
for file in "$logs/browser.env" "$logs/compose.override.yml" "$logs/browser-settings.json" \
  services/meilisearch/meilisearch.env services/meilisearch/compose.override.yml; do
  [[ -f "$stage/$file" ]] && generated+=("$file")
done
if (( ${#generated[@]} )); then
  tar -czf "$work_dir/bundle.tar.gz" "${bundle_paths[@]}" -C "$stage" "${generated[@]}"
else
  tar -czf "$work_dir/bundle.tar.gz" "${bundle_paths[@]}"
fi
# Paths are expanded locally; every interpolated value is allowlisted above.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$target" "umask 077; mkdir -p '$release'"
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$target" "tar -xzf - -C '$release'" < "$work_dir/bundle.tar.gz"
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$target" "bash '$release/scripts/activate.sh' '$VPS_DEPLOY_DIR' '$DEPLOY_ID'"
