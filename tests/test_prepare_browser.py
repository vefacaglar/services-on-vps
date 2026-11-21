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

    def test_totp_secret_is_added_only_to_private_browser_env(self):
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        base = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password"}
        # Grouped, lower-case and padded forms are stored in canonical form.
        for value in [secret, "gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ", secret + "="]:
            with self.subTest(value=value):
                self.assertTrue(prepare(self.directory, dict(base, LOGS_UI_TOTP_SECRET=value), lambda _: TEST_HASH))
                credentials = self.directory / "browser.env"
                self.assertIn(f"LOGS_UI_TOTP_SECRET={secret}\n", credentials.read_text())
                self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
                for other in self.directory.iterdir():
                    if other != credentials:
                        self.assertNotIn(secret, other.read_text(), other.name)
        # Removing the secret turns the second factor off again.
        prepare(self.directory, base, lambda _: TEST_HASH)
        self.assertNotIn("LOGS_UI_TOTP_SECRET", (self.directory / "browser.env").read_text())

    def test_unsafe_totp_secret_is_rejected_without_echoing_it(self):
        for secret in ["JBSWY3DPEHPK3PXP", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJ1", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\nX=1",
                       "GEZDGNBVGY3TQOJQGEZDGNBVGY3", "A" * 104, "otpauth://totp/logs?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]:
            with self.subTest(length=len(secret)):
                with self.assertRaises(ValueError) as caught:
                    prepare(self.directory, {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password",
                                             "LOGS_UI_TOTP_SECRET": secret}, lambda _: TEST_HASH)
                self.assertNotIn(secret[:16], str(caught.exception))
        self.assertFalse((self.directory / "browser.env").exists())

    def test_unsafe_meilisearch_key_is_rejected(self):
        for key in ["short", "has space in the middle!!", "newline-key-123456\n", "k" * 513]:
            with self.subTest(length=len(key)), self.assertRaises(ValueError):
                prepare(self.directory, {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password",
                                         "MEILI_MASTER_KEY": key}, lambda _: TEST_HASH)
        self.assertFalse((self.directory / "browser.env").exists())

    def test_postgres_url_is_added_only_to_private_browser_env(self):
        dsn = "postgres://logs_console:p%40ss-8841@postgres:5432/postgres?sslmode=disable"
        environment = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password", "POSTGRES_URL": dsn,
                       "POSTGRES_READONLY_URL": "postgres://old:old-pw-1@postgres/app"}
        self.assertTrue(prepare(self.directory, environment, lambda _: TEST_HASH))
        credentials = self.directory / "browser.env"
        self.assertTrue(credentials.read_text().endswith(f"POSTGRES_URL={dsn}\n"))
        self.assertNotIn("old-pw-1", credentials.read_text())
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        for other in self.directory.iterdir():
            if other != credentials:
                self.assertNotIn("p%40ss-8841", other.read_text(), other.name)

    def test_older_readonly_url_name_still_works(self):
        dsn = "postgres://logs_console_ro:ro-8841@postgres:5432/postgres"
        environment = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password", "POSTGRES_READONLY_URL": dsn}
        self.assertTrue(prepare(self.directory, environment, lambda _: TEST_HASH))
        self.assertTrue((self.directory / "browser.env").read_text().endswith(f"POSTGRES_URL={dsn}\n"))

    def test_write_switch_is_copied_only_when_set(self):
        base = {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password"}
        for value in ["", "true", "false"]:
            with self.subTest(value=value):
                self.assertTrue(prepare(self.directory, dict(base, POSTGRES_WRITE_ENABLED=value), lambda _: TEST_HASH))
                text = (self.directory / "browser.env").read_text()
                if value:
                    self.assertIn(f"POSTGRES_WRITE_ENABLED={value}\n", text)
                else:
                    self.assertNotIn("POSTGRES_WRITE_ENABLED", text)
        for value in ["False", "no", "true\nX=1"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                prepare(self.directory, dict(base, POSTGRES_WRITE_ENABLED=value), lambda _: TEST_HASH)

    def test_unsafe_postgres_url_is_rejected_without_echoing_it(self):
        for dsn in ["mysql://u:secret-pw@db/app", "postgres://u:secret-pw@db/app\nX=1", "postgres://:secret-pw@db/app",
                    "postgres://u:secret-pw@/app", "postgres://u:secret-pw@db:port/app", "postgres://u:secret#pw@db/app",
                    "postgres://u:secret-pw@db/" + "a" * 2100]:
            with self.subTest(index=dsn[:12]):
                with self.assertRaises(ValueError) as caught:
                    prepare(self.directory, {"LOGS_UI_USERNAME": "vefa", "LOGS_UI_PASSWORD": "private-test-password",
                                             "POSTGRES_URL": dsn}, lambda _: TEST_HASH)
                self.assertNotIn("secret", str(caught.exception))
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
