import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE = runpy.run_path(str(ROOT / "scripts/prepare-woodpecker.py"))
prepare = MODULE["prepare"]
prepare_browser = runpy.run_path(str(ROOT / "scripts/prepare-browser.py"))["prepare"]
AGENT = "a1" * 32
VALID = {"WOODPECKER_GITHUB_CLIENT": "Ov23liTESTclient0001", "WOODPECKER_GITHUB_SECRET": "0123456789abcdef" * 2 + "01234567",
         "WOODPECKER_AGENT_SECRET": AGENT, "WOODPECKER_ADMIN": "octo-cat"}


class WoodpeckerBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_absent_secrets_skip_woodpecker(self):
        self.assertFalse(prepare(self.directory, {"WOODPECKER_ADMIN": "octo-cat"}))
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_private_env_files_and_default_route(self):
        self.assertTrue(prepare(self.directory, VALID))
        server = (self.directory / "server.env").read_text()
        self.assertIn("WOODPECKER_HOST=https://ci.vefacaglar.com\n", server)
        self.assertIn("WOODPECKER_ADMIN=octo-cat\n", server)
        self.assertIn("WOODPECKER_GRPC_SECRET=" + hashlib.sha256(("woodpecker-grpc:" + AGENT).encode()).hexdigest(), server)
        # The agent only learns the shared agent secret.
        self.assertEqual((self.directory / "agent.env").read_text(), f"WOODPECKER_AGENT_SECRET={AGENT}\n")
        for name in ("server.env", "agent.env"):
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.directory / "compose.override.yml").exists())
        settings = json.loads((self.directory / "caddy-settings.json").read_text())
        self.assertEqual(settings["container"], "caddy")
        self.assertEqual(settings["route"]["domain"], "ci.vefacaglar.com")
        self.assertEqual(settings["route"]["upstream"], "woodpecker-server:8000")
        self.assertNotIn(VALID["WOODPECKER_GITHUB_SECRET"], json.dumps(settings))

    def test_domain_network_and_caddy_container_can_be_overridden(self):
        prepare(self.directory, dict(VALID, WOODPECKER_DOMAIN="build.example.test", LOGS_PROXY_NETWORK="existing_proxy",
                                     LOGS_CADDY_CONTAINER="main-caddy", WOODPECKER_ADMIN="octo-cat,second-admin"))
        self.assertIn("WOODPECKER_HOST=https://build.example.test\n", (self.directory / "server.env").read_text())
        self.assertIn("name: existing_proxy", (self.directory / "compose.override.yml").read_text())
        settings = json.loads((self.directory / "caddy-settings.json").read_text())
        self.assertEqual((settings["container"], settings["route"]["domain"]), ("main-caddy", "build.example.test"))

    def test_partial_or_unsafe_values_are_rejected(self):
        for change in [
            {"WOODPECKER_GITHUB_SECRET": ""}, {"WOODPECKER_AGENT_SECRET": ""}, {"WOODPECKER_ADMIN": ""},
            {"WOODPECKER_AGENT_SECRET": "too-short"}, {"WOODPECKER_AGENT_SECRET": AGENT + "\nWOODPECKER_OPEN=true"},
            {"WOODPECKER_GITHUB_CLIENT": "client id with spaces"}, {"WOODPECKER_GITHUB_SECRET": "secret\nX=1" + "a" * 20},
            {"WOODPECKER_ADMIN": "octo cat"}, {"WOODPECKER_ADMIN": "octo-cat\nWOODPECKER_OPEN=true"},
            {"WOODPECKER_DOMAIN": "ci.example.test/path"}, {"WOODPECKER_DOMAIN": "CI.example.test"},
            {"WOODPECKER_DOMAIN": "localhost"}, {"LOGS_PROXY_NETWORK": "bad\nname: x"},
        ]:
            with self.subTest(change=repr(change)):
                with self.assertRaises(ValueError):
                    prepare(self.directory, dict(VALID, **change))

    def test_console_receives_api_token_and_public_url(self):
        token = "eyJhbGciOiJIUzI1NiJ9.test-token-payload.signature_7781"
        base = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password"}
        hashed = lambda _: "$2a$14$" + "A" * 53
        prepare_browser(self.directory, dict(base, **VALID, WOODPECKER_API_TOKEN=token), hashed)
        credentials = self.directory / "browser.env"
        text = credentials.read_text()
        self.assertIn(f"WOODPECKER_API_TOKEN={token}\n", text)
        self.assertIn("WOODPECKER_PUBLIC_URL=https://ci.vefacaglar.com\n", text)
        self.assertNotIn(VALID["WOODPECKER_GITHUB_SECRET"], text)
        self.assertNotIn(AGENT, text)
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        prepare_browser(self.directory, base, hashed)
        self.assertNotIn("WOODPECKER", credentials.read_text())
        with self.assertRaises(ValueError):
            prepare_browser(self.directory, dict(base, WOODPECKER_API_TOKEN="bad token\nX=1"), hashed)


if __name__ == "__main__":
    unittest.main()
