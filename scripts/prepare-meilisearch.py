#!/usr/bin/env python3
"""Write the optional Meilisearch master key file for the deployment bundle.

The key arrives only through the MEILI_MASTER_KEY environment variable and is
written to a 0600 env file; it never appears in command arguments or output.
"""
import os
from pathlib import Path
import re
import sys


def validate_key(key):
    """Shared with prepare-browser.py, which hands the same key to the log console."""
    if len(key.encode()) < 16 or len(key.encode()) > 512 or re.search(r"\s", key):
        raise ValueError("Set MEILI_MASTER_KEY using at least 16 bytes without whitespace or newlines")


def prepare(destination, environment=None):
    environment = os.environ if environment is None else environment
    key = environment.get("MEILI_MASTER_KEY", "")
    if not key:
        return False
    validate_key(key)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    credentials = destination / "meilisearch.env"
    credentials.touch(mode=0o600)
    credentials.chmod(0o600)
    credentials.write_text(f"MEILI_MASTER_KEY={key}\n")
    network = environment.get("LOGS_PROXY_NETWORK", "")
    if network:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", network):
            raise ValueError("Invalid LOGS_PROXY_NETWORK")
        # Same deploy-time network choice as the logs browser override.
        (destination / "compose.override.yml").write_text(f"networks:\n  proxy:\n    name: {network}\n")
    return True


if __name__ == "__main__":
    try:
        configured = prepare(sys.argv[1])
        print("Meilisearch master key configured." if configured else "Meilisearch secret absent; Meilisearch is not deployed.")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
