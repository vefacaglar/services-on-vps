import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_ID = "a" * 40 + "-123-1"
NEXT_ID = "b" * 40 + "-124-1"


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="logs-deploy-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def release(self, deploy_id, status=0):
        release = self.base / "releases" / deploy_id
        (release / "scripts").mkdir(parents=True)
        (release / ".env.example").write_text("VPS_LOG_HOST=default\n")
        start = release / "scripts/start.sh"
        start.write_text(
            f"#!/bin/sh\nprintf '%s\\n' '{deploy_id}' >> '{self.base}/attempts'\nexit {status}\n"
        )
        start.chmod(0o755)
        return release

    def activate(self, deploy_id, environment=None):
        return subprocess.run(
            ["bash", str(ROOT / "scripts/activate.sh"), str(self.base), deploy_id],
            capture_output=True, text=True, env=environment,
        )

    def test_success_keeps_server_environment_and_switches_release(self):
        self.release(DEPLOY_ID)
        self.assertEqual(self.activate(DEPLOY_ID).returncode, 0)
        (self.base / ".env").write_text("VPS_LOG_HOST=custom\n")
        newer = self.release(NEXT_ID)
        result = self.activate(NEXT_ID)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / "current").resolve(), newer)
        self.assertEqual((newer / ".env").read_text(), "VPS_LOG_HOST=custom\n")
        self.assertEqual((self.base / ".env").stat().st_mode & 0o777, 0o600)

    def test_service_layout_shares_one_environment_file(self):
        self.release(DEPLOY_ID)
        self.assertEqual(self.activate(DEPLOY_ID).returncode, 0)
        (self.base / ".env").write_text("VPS_LOG_HOST=custom\n")
        newer = self.release(NEXT_ID)
        (newer / ".env.example").unlink()
        for service in ("logs", "meilisearch"):
            (newer / "services" / service).mkdir(parents=True)
        (newer / "services/logs/.env.example").write_text("VPS_LOG_HOST=default\n")
        result = self.activate(NEXT_ID)
        self.assertEqual(result.returncode, 0, result.stderr)
        for service in ("logs", "meilisearch"):
            self.assertEqual((newer / "services" / service / ".env").read_text(), "VPS_LOG_HOST=custom\n")

    def test_first_service_layout_deploy_creates_environment_from_logs_example(self):
        release = self.release(DEPLOY_ID)
        (release / ".env.example").unlink()
        (release / "services/logs").mkdir(parents=True)
        (release / "services/logs/.env.example").write_text("VPS_LOG_HOST=logs-example\n")
        result = self.activate(DEPLOY_ID)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / ".env").read_text(), "VPS_LOG_HOST=logs-example\n")

    def test_failed_update_restores_previous_release_and_reports_failure(self):
        previous = self.release(DEPLOY_ID)
        self.assertEqual(self.activate(DEPLOY_ID).returncode, 0)
        self.release(NEXT_ID, status=1)
        result = self.activate(NEXT_ID)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / "current").resolve(), previous)
        self.assertEqual((self.base / "attempts").read_text().splitlines(), [DEPLOY_ID, NEXT_ID, DEPLOY_ID])

    def test_first_deploy_failure_does_not_publish_current_link(self):
        self.release(DEPLOY_ID, status=1)
        result = self.activate(DEPLOY_ID)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No previous managed release", result.stderr)
        self.assertFalse((self.base / "current").exists())

    def test_rollback_failure_is_explicit(self):
        self.release(DEPLOY_ID)
        self.assertEqual(self.activate(DEPLOY_ID).returncode, 0)
        (self.base / "releases" / DEPLOY_ID / "scripts/start.sh").write_text("#!/bin/sh\nexit 1\n")
        self.release(NEXT_ID, status=1)
        result = self.activate(NEXT_ID)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Rollback also failed", result.stderr)

    def test_caddy_configuration_failure_restores_previous_release(self):
        previous = self.release(DEPLOY_ID)
        self.assertEqual(self.activate(DEPLOY_ID).returncode, 0)
        newer = self.release(NEXT_ID)
        (newer / 'services/logs').mkdir(parents=True)
        (newer / 'services/logs/browser.env').write_text('test hash only\n')
        (newer / 'services/logs/browser-settings.json').write_text('{}')
        binaries = self.base / 'bin'
        binaries.mkdir()
        python = binaries / 'python3'
        python.write_text('#!/bin/sh\nexit 1\n')
        python.chmod(0o755)
        environment = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'])
        result = self.activate(NEXT_ID, environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / 'current').resolve(), previous)
        self.assertEqual((self.base / 'attempts').read_text().splitlines(), [DEPLOY_ID, NEXT_ID, DEPLOY_ID])


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="logs-transport-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        shutil.copytree(ROOT, self.repo, ignore=shutil.ignore_patterns(
            ".git", "node_modules", "__pycache__", ".env", "browser.env", "compose.override.yml",
            "meilisearch.env", "static"))
        (self.repo / ".env").write_text("DO_NOT_UPLOAD=private\n")
        (self.repo / "services/logs/.env").write_text("DO_NOT_UPLOAD=private\n")
        (self.repo / "services/meilisearch/meilisearch.env").write_text("MEILI_MASTER_KEY=local-only-key\n")
        (self.repo / "unrelated-private.txt").write_text("private\n")
        self.bin = self.base / "bin"
        self.bin.mkdir()
        fake_ssh = self.bin / "ssh"
        fake_ssh.write_text("""#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
key = pathlib.Path(args[args.index('-i') + 1])
assert stat.S_IMODE(key.stat().st_mode) == 0o600
with open(os.environ['SSH_CALLS'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
if args[-1].startswith('tar '):
    pathlib.Path(os.environ['BUNDLE_COPY']).write_bytes(sys.stdin.buffer.read())
if 'activate.sh' in args[-1]:
    sys.exit(int(os.environ.get('ACTIVATE_STATUS', '0')))
""")
        fake_ssh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        VPS_HOST="vps.example.test", VPS_USER="root", VPS_PORT="22",
                        VPS_SSH_KEY="test-private-key", VPS_KNOWN_HOSTS="test-host-key",
                        VPS_DEPLOY_DIR="/opt/logs-on-vps", DEPLOY_ID=DEPLOY_ID,
                        LOGS_UI_USERNAME="", LOGS_UI_PASSWORD="", MEILI_MASTER_KEY="",
                        SSH_CALLS=str(self.base / "calls"), BUNDLE_COPY=str(self.base / "bundle.tar.gz"))

    def deploy(self):
        return subprocess.run(["bash", str(self.repo / "scripts/ssh-deploy.sh")],
                              env=self.env, capture_output=True, text=True)

    def test_bundle_allowlist_host_verification_and_credential_cleanup(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.base / "bundle.tar.gz") as bundle:
            names = bundle.getnames()
        for name in ["README.md", "scripts/start.sh", "scripts/activate.sh", "services/logs/.env.example",
                     "services/logs/.dockerignore", "services/logs/compose.yml", "services/logs/console/Dockerfile",
                     "services/logs/client/src/main.tsx", "services/logs/client/package-lock.json",
                     "services/logs/scripts/start.sh", "services/logs/vector/vector.yaml",
                     "services/meilisearch/compose.yml", "services/meilisearch/scripts/start.sh"]:
            self.assertIn(name, names)
        self.assertFalse(any("node_modules" in name for name in names))
        for name in [".env", "services/logs/.env", "services/meilisearch/meilisearch.env",
                     "services/logs/browser.env"]:
            self.assertNotIn(name, names)
        self.assertNotIn("unrelated-private.txt", names)
        calls = [json.loads(line) for line in (self.base / "calls").read_text().splitlines()]
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertIn("StrictHostKeyChecking=yes", call)
            self.assertIn("BatchMode=yes", call)
            self.assertFalse(Path(call[call.index("-i") + 1]).exists())

    def test_unsafe_paths_are_rejected_before_connecting(self):
        for path in ["/", "/opt/../root", "/opt/logs;whoami", "relative", "/opt/logs on vps"]:
            self.env["VPS_DEPLOY_DIR"] = path
            self.assertNotEqual(self.deploy().returncode, 0, path)
        self.assertFalse((self.base / "calls").exists())

    def test_remote_failure_is_not_reported_as_success(self):
        self.env["ACTIVATE_STATUS"] = "17"
        self.assertEqual(self.deploy().returncode, 17)

    def test_browser_bundle_contains_hash_and_never_plaintext_password(self):
        password = "not-saved-anywhere-599"
        self.env.update(LOGS_UI_USERNAME="vefa", LOGS_UI_PASSWORD=password)
        fake_docker = self.bin / "docker"
        fake_docker.write_text("""#!/usr/bin/env python3
import os, sys
assert 'LOGS_UI_PASSWORD' not in os.environ
assert sys.stdin.read() == 'not-saved-anywhere-599\\n'
assert 'not-saved-anywhere-599' not in ' '.join(sys.argv)
print('$2a$14$' + 'A' * 53)
""")
        fake_docker.chmod(0o755)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(password, result.stdout + result.stderr)
        with tarfile.open(self.base / "bundle.tar.gz") as bundle:
            self.assertIn("services/logs/compose.override.yml", bundle.getnames())
            self.assertIn("services/logs/browser-settings.json", bundle.getnames())
            self.assertEqual(bundle.getmember("services/logs/browser.env").mode & 0o777, 0o600)
            for member in bundle.getmembers():
                if member.isfile():
                    self.assertNotIn(password.encode(), bundle.extractfile(member).read(), member.name)

    def test_meilisearch_key_travels_only_in_private_env_file(self):
        key = "meili-test-master-key-8841"
        self.env.update(MEILI_MASTER_KEY=key, LOGS_PROXY_NETWORK="existing_proxy")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(key, result.stdout + result.stderr)
        with tarfile.open(self.base / "bundle.tar.gz") as bundle:
            member = bundle.getmember("services/meilisearch/meilisearch.env")
            self.assertEqual(member.mode & 0o777, 0o600)
            self.assertEqual(bundle.extractfile(member).read().decode(), f"MEILI_MASTER_KEY={key}\n")
            override = bundle.extractfile("services/meilisearch/compose.override.yml").read().decode()
            self.assertIn("name: existing_proxy", override)
            for other in bundle.getmembers():
                if other.isfile() and other.name != member.name:
                    self.assertNotIn(key.encode(), bundle.extractfile(other).read(), other.name)
        for line in (self.base / "calls").read_text().splitlines():
            self.assertNotIn(key, line)

    def test_console_receives_meilisearch_key_in_private_browser_env(self):
        key = "meili-test-master-key-8841"
        self.env.update(LOGS_UI_USERNAME="vefa", LOGS_UI_PASSWORD="not-saved-anywhere-599", MEILI_MASTER_KEY=key)
        fake_docker = self.bin / "docker"
        fake_docker.write_text("""#!/usr/bin/env python3
import os, sys
assert 'MEILI_MASTER_KEY' not in os.environ
sys.stdin.read()
print('$2a$14$' + 'A' * 53)
""")
        fake_docker.chmod(0o755)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(key, result.stdout + result.stderr)
        private = {"services/logs/browser.env", "services/meilisearch/meilisearch.env"}
        with tarfile.open(self.base / "bundle.tar.gz") as bundle:
            browser = bundle.getmember("services/logs/browser.env")
            self.assertEqual(browser.mode & 0o777, 0o600)
            self.assertIn(f"MEILI_MASTER_KEY={key}\n", bundle.extractfile(browser).read().decode())
            for other in bundle.getmembers():
                if other.isfile() and other.name not in private:
                    self.assertNotIn(key.encode(), bundle.extractfile(other).read(), other.name)
        for line in (self.base / "calls").read_text().splitlines():
            self.assertNotIn(key, line)

    def test_postgres_url_travels_only_in_private_browser_env(self):
        dsn = "postgres://logs_console_ro:pg-secret-7731@postgres:5432/app"
        self.env.update(LOGS_UI_USERNAME="vefa", LOGS_UI_PASSWORD="not-saved-anywhere-599", POSTGRES_READONLY_URL=dsn)
        fake_docker = self.bin / "docker"
        fake_docker.write_text("""#!/usr/bin/env python3
import os, sys
assert 'POSTGRES_READONLY_URL' not in os.environ
sys.stdin.read()
print('$2a$14$' + 'A' * 53)
""")
        fake_docker.chmod(0o755)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("pg-secret-7731", result.stdout + result.stderr)
        with tarfile.open(self.base / "bundle.tar.gz") as bundle:
            browser = bundle.getmember("services/logs/browser.env")
            self.assertEqual(browser.mode & 0o777, 0o600)
            self.assertIn(f"POSTGRES_READONLY_URL={dsn}\n", bundle.extractfile(browser).read().decode())
            for other in bundle.getmembers():
                if other.isfile() and other.name != browser.name:
                    self.assertNotIn(b"pg-secret-7731", bundle.extractfile(other).read(), other.name)
        for line in (self.base / "calls").read_text().splitlines():
            self.assertNotIn("pg-secret-7731", line)

    def test_invalid_postgres_url_stops_before_connecting(self):
        self.env.update(LOGS_UI_USERNAME="vefa", LOGS_UI_PASSWORD="not-saved-anywhere-599",
                        POSTGRES_READONLY_URL="mysql://u:pg-secret-7731@db/app")
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("pg-secret-7731", result.stdout + result.stderr)
        self.assertFalse((self.base / "calls").exists())

    def test_invalid_meilisearch_key_stops_before_connecting(self):
        for key in ["short", "has space in the middle!!", "newline-key-123456\n"]:
            self.env["MEILI_MASTER_KEY"] = key
            self.assertNotEqual(self.deploy().returncode, 0, key)
        self.assertFalse((self.base / "calls").exists())


if __name__ == "__main__":
    unittest.main()
