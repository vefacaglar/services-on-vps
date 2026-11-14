from pathlib import Path
import runpy
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
prepare = runpy.run_path(str(ROOT / "scripts/prepare-meilisearch.py"))["prepare"]


class MeilisearchBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_absent_secret_skips_meilisearch(self):
        self.assertFalse(prepare(self.directory, {}))
        self.assertFalse((self.directory / "meilisearch.env").exists())

    def test_key_file_is_private_and_network_is_optional(self):
        key = "0123456789abcdef-$dollar"
        self.assertTrue(prepare(self.directory, {"MEILI_MASTER_KEY": key}))
        credentials = self.directory / "meilisearch.env"
        self.assertEqual(credentials.read_text(), f"MEILI_MASTER_KEY={key}\n")
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.directory / "compose.override.yml").exists())
        prepare(self.directory, {"MEILI_MASTER_KEY": key, "LOGS_PROXY_NETWORK": "existing_proxy"})
        self.assertIn("name: existing_proxy", (self.directory / "compose.override.yml").read_text())

    def test_weak_or_unsafe_values_are_rejected(self):
        for environment in [
            {"MEILI_MASTER_KEY": "fifteen-bytes!!"},
            {"MEILI_MASTER_KEY": "sixteen-bytes-ok\n"},
            {"MEILI_MASTER_KEY": "with space inside the key"},
            {"MEILI_MASTER_KEY": "\tleading-tab-key-1234"},
            {"MEILI_MASTER_KEY": "0123456789abcdef", "LOGS_PROXY_NETWORK": "bad\nname: x"},
        ]:
            with self.subTest(environment=repr(environment)):
                with self.assertRaises(ValueError):
                    prepare(self.directory, environment)


if __name__ == "__main__":
    unittest.main()
