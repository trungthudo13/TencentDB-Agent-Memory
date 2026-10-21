import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import tomlkit

from memagent.cli import main


class InitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_init(self, platform, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = main(["init", "--platform", platform, "--home", str(self.root),
                           "--user_key", "sk-mem-test", "--agent_id", "agt-1",
                           "--team_id", "team-1", *extra])
        self.assertNotIn("sk-mem-test", output.getvalue())
        self.assertEqual(result, 0)

    def test_codex_merge_backup_and_repeat(self):
        path = self.root / ".codex/config.toml"
        path.parent.mkdir()
        original = ('# keep me\nmodel = "my-model"\n'
                    '[model_providers.memory_proxy.env_http_headers]\n'
                    'X-Team-Id = "OLD_TEAM"\n'
                    '[mcp_servers.demo]\ncommand = "demo"\n')
        path.write_text(original)
        self.run_init("codex")
        doc = tomlkit.parse(path.read_text())
        self.assertIn("# keep me", path.read_text())
        self.assertEqual(doc["model"], "my-model")
        self.assertEqual(doc["mcp_servers"]["demo"]["command"], "demo")
        provider = doc["model_providers"]["memory_proxy"]
        self.assertTrue(provider["requires_openai_auth"])
        self.assertEqual(provider["http_headers"]["x-team-id"], "team-1")
        self.assertNotIn("X-Team-Id", provider["env_http_headers"])
        backups = list(path.parent.glob("*.bak-*"))
        self.assertEqual(backups[0].read_text(), original)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.run_init("codex")
        self.assertEqual(list(path.parent.glob("*.bak-*")), backups)

    def test_claude_preserves_headers_and_settings(self):
        path = self.root / ".claude/settings.json"
        path.parent.mkdir()
        path.write_text(json.dumps({"permissions": {"allow": ["Read"]}, "env": {
            "ANTHROPIC_MODEL": "custom-model",
            "ANTHROPIC_CUSTOM_HEADERS": "X-Team-Id: old\nX-Custom: keep"}}))
        self.run_init("claude", "--proxy-url", "https://proxy.example/prefix/", "--service-id", "space")
        doc = json.loads(path.read_text())
        self.assertEqual(doc["permissions"], {"allow": ["Read"]})
        self.assertEqual(doc["env"]["ANTHROPIC_MODEL"], "custom-model")
        self.assertEqual(doc["env"]["ANTHROPIC_BASE_URL"], "https://proxy.example/prefix/claude-code/space")
        headers = doc["env"]["ANTHROPIC_CUSTOM_HEADERS"]
        self.assertIn("X-Custom: keep", headers)
        self.assertNotIn("old", headers)
        self.assertIn("x-agent-id: agt-1", headers)
        before = path.read_bytes()
        self.run_init("claude", "--proxy-url", "https://proxy.example/prefix/", "--service-id", "space")
        self.assertEqual(path.read_bytes(), before)

    def test_new_configs(self):
        for platform in ("codex", "claude"):
            self.run_init(platform)

    def test_invalid_configs_untouched(self):
        for platform, relative in (("codex", ".codex/config.toml"), ("claude", ".claude/settings.json")):
            path = self.root / relative
            path.parent.mkdir()
            path.write_text("invalid sk-mem-secret")
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit):
                    self.run_init(platform)
            self.assertNotIn("sk-mem-secret", errors.getvalue())
            self.assertEqual(path.read_text(), "invalid sk-mem-secret")
            self.assertEqual(list(path.parent.glob("*.bak-*")), [])

    def test_header_injection_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.run_init("claude", "--team-id", "team\nx-other: injected")
        self.assertFalse((self.root / ".claude").exists())
