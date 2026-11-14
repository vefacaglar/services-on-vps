#!/usr/bin/env python3
"""Create optional browser configuration without persisting the plaintext password.

The destination is the logs service directory of the bundle (services/logs), so
compose.override.yml sits next to compose.yml and ./browser.env resolves there.
"""
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
validate_meili_key = runpy.run_path(str(ROOT / "scripts/prepare-meilisearch.py"))["validate_key"]
CADDY_IMAGE = "caddy:2-alpine@sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9"


def validate_postgres_url(dsn):
    """A postgres:// DSN for the console's PostgreSQL views and write mode.

    Checked without echoing the value: errors never include the DSN.
    """
    if len(dsn.encode()) > 2048 or re.search(r"\s", dsn) or "\x00" in dsn:
        raise ValueError("Set POSTGRES_URL as one line without whitespace (at most 2048 bytes)")
    try:
        parts = urlsplit(dsn)
        host, user = parts.hostname, parts.username
        parts.port  # Raises on a non-numeric port.
    except ValueError:
        raise ValueError("POSTGRES_URL is not a valid postgres:// URL") from None
    if parts.scheme not in ("postgres", "postgresql") or not host or not user or parts.fragment:
        raise ValueError("Set POSTGRES_URL as postgres://user:password@host:5432/database")


def prepare(destination, environment=None, hash_password=None):
    environment = os.environ if environment is None else environment
    username = environment.get("LOGS_UI_USERNAME", "")
    password = environment.get("LOGS_UI_PASSWORD", "")
    if not username and not password:
        return False
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", username):
        raise ValueError("Set LOGS_UI_USERNAME using 1-64 letters, digits, underscores or hyphens")
    if not 12 <= len(password.encode()) <= 72 or password != password.strip() or "\n" in password or "\r" in password:
        raise ValueError("Set LOGS_UI_PASSWORD using 12-72 UTF-8 bytes without newlines or surrounding whitespace")
    meili_key = environment.get("MEILI_MASTER_KEY", "")
    if meili_key:
        # Lets the console's read-only Meilisearch views call it server-side.
        validate_meili_key(meili_key)
    # One DSN for reads and write mode; POSTGRES_READONLY_URL is the older name.
    postgres_url = environment.get("POSTGRES_URL", "") or environment.get("POSTGRES_READONLY_URL", "")
    if postgres_url:
        validate_postgres_url(postgres_url)
    # Kill switch for write mode (a GitHub environment variable, not a secret).
    write_enabled = environment.get("POSTGRES_WRITE_ENABLED", "")
    if write_enabled not in ("", "true", "false"):
        raise ValueError("Set POSTGRES_WRITE_ENABLED to true or false (or leave it unset)")
    if hash_password is None:
        # The secret travels only via stdin, not command arguments or child env.
        child_env = dict(os.environ)
        child_env.pop("LOGS_UI_PASSWORD", None)
        child_env.pop("LOGS_UI_USERNAME", None)
        child_env.pop("MEILI_MASTER_KEY", None)
        child_env.pop("POSTGRES_URL", None)
        child_env.pop("POSTGRES_READONLY_URL", None)
        result = subprocess.run(
            ["docker", "run", "--rm", "-i", CADDY_IMAGE, "caddy", "hash-password"],
            input=(password + "\n").encode(), capture_output=True, env=child_env, check=False,
        )
        if result.returncode:
            raise ValueError("Caddy password hashing failed; check Docker availability")
        password_hash = result.stdout.decode().strip()
    else:
        password_hash = hash_password(password)
    if not re.fullmatch(r"\$2[aby]\$\d{2}\$[./a-zA-Z0-9]{53}", password_hash):
        raise ValueError("Caddy returned an invalid bcrypt hash")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    credentials = destination / "browser.env"
    credentials.touch(mode=0o600)
    credentials.chmod(0o600)
    lines = f"LOGS_UI_USERNAME={username}\nLOGS_UI_PASSWORD_HASH={password_hash}\n"
    if meili_key:
        lines += f"MEILI_MASTER_KEY={meili_key}\n"
    if postgres_url:
        lines += f"POSTGRES_URL={postgres_url}\n"
    if write_enabled:
        lines += f"POSTGRES_WRITE_ENABLED={write_enabled}\n"
    credentials.write_text(lines)
    override = (ROOT / "services/logs/deploy/compose.browser.yml").read_text()
    network = environment.get("LOGS_PROXY_NETWORK", "")
    if network:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", network):
            raise ValueError("Invalid LOGS_PROXY_NETWORK")
        override = override.replace("${LOGS_PROXY_NETWORK:-databases_default}", network)
    (destination / "compose.override.yml").write_text(override)
    (destination / "browser-settings.json").write_text(json.dumps({
        "container": environment.get("LOGS_CADDY_CONTAINER", "") or "caddy",
        "config_path": environment.get("LOGS_CADDY_CONFIG_PATH", ""),
    }))
    return True


if __name__ == "__main__":
    try:
        configured = prepare(sys.argv[1])
        print("Browser authentication configured." if configured else "Browser secrets absent; keeping local-only access.")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
