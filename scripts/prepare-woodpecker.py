#!/usr/bin/env python3
"""Write the optional Woodpecker CI configuration for the deployment bundle.

Secrets arrive only through environment variables and are written to 0600 env
files; they never appear in command arguments or output.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


DEFAULT_DOMAIN = "ci.vefacaglar.com"
SECRETS = ("WOODPECKER_GITHUB_CLIENT", "WOODPECKER_GITHUB_SECRET", "WOODPECKER_AGENT_SECRET")


def validate_token(token):
    """Shared with prepare-browser.py, which hands the API token to the log console."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{20,2048}", token):
        raise ValueError("Set WOODPECKER_API_TOKEN to the personal access token shown in Woodpecker's user settings")


def domain(environment):
    value = environment.get("WOODPECKER_DOMAIN", "") or DEFAULT_DOMAIN
    labels = value.split(".")
    if len(value) > 253 or len(labels) < 2 or not all(re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
        raise ValueError("Set WOODPECKER_DOMAIN to a lowercase host name such as ci.example.com")
    return value


def configured(environment):
    """True when Woodpecker is deployed; raises when only part of it is set."""
    present = [name for name in SECRETS if environment.get(name, "")]
    if not present:
        return False
    if len(present) != len(SECRETS) or not environment.get("WOODPECKER_ADMIN", ""):
        raise ValueError("Set WOODPECKER_GITHUB_CLIENT, WOODPECKER_GITHUB_SECRET, WOODPECKER_AGENT_SECRET and WOODPECKER_ADMIN together")
    return True


def prepare(destination, environment=None):
    environment = os.environ if environment is None else environment
    if not configured(environment):
        return False
    client = environment["WOODPECKER_GITHUB_CLIENT"]
    secret = environment["WOODPECKER_GITHUB_SECRET"]
    agent = environment["WOODPECKER_AGENT_SECRET"]
    admin = environment["WOODPECKER_ADMIN"]
    if not re.fullmatch(r"[A-Za-z0-9._-]{8,128}", client):
        raise ValueError("WOODPECKER_GITHUB_CLIENT must be the OAuth app's client ID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{16,256}", secret):
        raise ValueError("WOODPECKER_GITHUB_SECRET must be the OAuth app's client secret")
    if not re.fullmatch(r"[A-Za-z0-9._-]{32,256}", agent):
        raise ValueError("Set WOODPECKER_AGENT_SECRET using at least 32 letters or digits, e.g. openssl rand -hex 32")
    # GitHub logins only: these accounts become Woodpecker admins and are the
    # only ones allowed to sign in while registration is closed.
    if not re.fullmatch(r"[A-Za-z0-9](-?[A-Za-z0-9]){0,38}(,[A-Za-z0-9](-?[A-Za-z0-9]){0,38}){0,9}", admin):
        raise ValueError("Set WOODPECKER_ADMIN to a GitHub user name (or a comma-separated list)")
    host = domain(environment)
    network = environment.get("LOGS_PROXY_NETWORK", "")
    if network and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", network):
        raise ValueError("Invalid LOGS_PROXY_NETWORK")
    container = environment.get("LOGS_CADDY_CONTAINER", "") or "caddy"

    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    # The gRPC signing key must survive restarts; deriving it avoids one more secret.
    grpc = hashlib.sha256(("woodpecker-grpc:" + agent).encode()).hexdigest()
    files = {
        "server.env": (
            f"WOODPECKER_HOST=https://{host}\n"
            f"WOODPECKER_GITHUB_CLIENT={client}\n"
            f"WOODPECKER_GITHUB_SECRET={secret}\n"
            f"WOODPECKER_ADMIN={admin}\n"
            f"WOODPECKER_AGENT_SECRET={agent}\n"
            f"WOODPECKER_GRPC_SECRET={grpc}\n"
        ),
        "agent.env": f"WOODPECKER_AGENT_SECRET={agent}\n",
    }
    for name, content in files.items():
        path = destination / name
        path.touch(mode=0o600)
        path.chmod(0o600)
        path.write_text(content)
    if network:
        # Same deploy-time network choice as the logs browser override.
        (destination / "compose.override.yml").write_text(f"networks:\n  proxy:\n    name: {network}\n")
    (destination / "caddy-settings.json").write_text(json.dumps({
        "container": container,
        "config_path": environment.get("LOGS_CADDY_CONFIG_PATH", ""),
        "route": {
            "name": "woodpecker", "domain": host, "upstream": "woodpecker-server:8000",
            "project": "woodpecker", "service": "server", "alias": "woodpecker-server",
        },
    }))
    return True


if __name__ == "__main__":
    try:
        ready = prepare(sys.argv[1])
        print("Woodpecker CI configured." if ready else "Woodpecker secrets absent; Woodpecker is not deployed.")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
