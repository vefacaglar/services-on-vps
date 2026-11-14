from pathlib import Path
import runpy
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
prepare = runpy.run_path(str(ROOT / "scripts/prepare-browser.py"))["prepare"]
TEST_HASH = "$2a$14$" + "A" * 53


class BrowserBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_no_secrets_keeps_local_only_access(self):
        self.assertFalse(prepare(self.directory, {}))
        self.assertFalse((self.directory / "compose.override.yml").exists())

    def test_only_hash_is_written_and_dollar_signs_survive(self):
        password = "private-test-password-529"
        environment = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": password}
        self.assertTrue(prepare(self.directory, environment, lambda _: TEST_HASH))
        credentials = self.directory / "browser.env"
        self.assertIn(TEST_HASH, credentials.read_text())
        self.assertNotIn(password, credentials.read_text())
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        self.assertIn("format: raw", (self.directory / "compose.override.yml").read_text())
        self.assertEqual((self.directory / 'browser-settings.json').read_text(), '{"container": "caddy", "config_path": ""}')

    def test_custom_proxy_network_can_be_configured_without_server_environment_edit(self):
        prepare(self.directory, {'LOGS_UI_USERNAME': 'vefa', 'LOGS_UI_PASSWORD': 'private-test-password',
                                 'LOGS_PROXY_NETWORK': 'existing_proxy', 'LOGS_CADDY_CONTAINER': 'main-caddy'},
                lambda _: TEST_HASH)
        self.assertIn('name: existing_proxy', (self.directory / 'compose.override.yml').read_text())
        self.assertIn('main-caddy', (self.directory / 'browser-settings.json').read_text())

    def test_meilisearch_key_is_added_only_to_private_browser_env(self):
        key = "meili-test-master-key-8841"
        environment = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password", "MEILI_MASTER_KEY": key}
        self.assertTrue(prepare(self.directory, environment, lambda _: TEST_HASH))
        credentials = self.directory / "browser.env"
        self.assertTrue(credentials.read_text().endswith(f"MEILI_MASTER_KEY={key}\n"))
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        for other in self.directory.iterdir():
            if other != credentials:
                self.assertNotIn(key, other.read_text(), other.name)
        prepare(self.directory, {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password"}, lambda _: TEST_HASH)
        self.assertNotIn("MEILI_MASTER_KEY", credentials.read_text())

    def test_unsafe_meilisearch_key_is_rejected(self):
        for key in ["short", "has space in the middle!!", "newline-key-123456\n", "k" * 513]:
            with self.subTest(length=len(key)), self.assertRaises(ValueError):
                prepare(self.directory, {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password",
                                         "MEILI_MASTER_KEY": key}, lambda _: TEST_HASH)
        self.assertFalse((self.directory / "browser.env").exists())

    def test_incomplete_credentials_and_config_injection_are_rejected(self):
        for environment in [
            {"LOGS_UI_USERNAME": "vefa"},
            {"LOGS_UI_PASSWORD": "private-test-password"},
            {"LOGS_UI_USERNAME": "bad user}", "LOGS_UI_PASSWORD": "private-test-password"},
            {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "short"},
            {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "A" * 73},
            {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-password\n"},
        ]:
            with self.subTest(environment=list(environment)):
                with self.assertRaises(ValueError):
                    prepare(self.directory, environment, lambda _: TEST_HASH)
        self.assertFalse((self.directory / "browser.env").exists())
