"""Installer preflight/approval regression checks; no live services or keys needed."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SOURCE = (Path(__file__).resolve().parents[1] / 'install.sh').read_text().split("python3 <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]


class InstallerChecks(unittest.TestCase):
    def run_install(self, fault=None, approve='y\n', client='codex'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / 'My Project'
            project.mkdir()
            user = root / 'user'
            calls = []
            prompt_seen = []
            env = dict(MI_CLIENT=client, MI_PROXY='http://proxy.test', MI_CORE='http://core.test',
                       MI_CORE_KEY='gateway-secret', MI_SPACE='default', MI_USER_KEY='user-secret',
                       MI_TEAM='team-1', MI_AGENT='agent-1', MI_MCP='y',
                       MI_MCP_URL='http://knowledge.test/mcp', MI_SERVICE='default', MI_SERVICE_KEY='knowledge-secret')

            class Response(io.BytesIO):
                pass

            class FakeOpener:
                def open(self, request, timeout):
                    self_test.assertEqual(timeout, 8)
                    calls.append(request.full_url)
                    route = request.full_url.rsplit('/', 1)[-1]
                    if fault == route:
                        raise HTTPError(request.full_url, 401, 'Denied', {}, None)
                    if route == 'health': data = {'status': 'ok'}
                    elif route == 'verify':
                        self_test.assertEqual(json.loads(request.data), {'user_key': 'user-secret'})
                        data = {'code': 0, 'data': {'valid': fault != 'invalid-key', 'user': {'user_id': 'user-1'}}}
                    elif '/team-member/' in request.full_url:
                        data = {'code': 0, 'data': {'team_id': 'team-1', 'user_id': 'user-1', 'status': 'removed' if fault == 'membership' else 'active'}}
                    elif '/team/' in request.full_url:
                        data = {'code': 0, 'data': {'team_id': 'team-1', 'status': 'active'}}
                    elif '/agent/' in request.full_url:
                        data = {'code': 0, 'data': {'agent_id': 'agent-1', 'team_id': 'other' if fault == 'team-mismatch' else 'team-1', 'owner_user_id': 'user-1', 'status': 'active'}}
                    elif route == 'mcp':
                        self_test.assertEqual(request.get_header('Authorization'), 'Bearer knowledge-secret')
                        self_test.assertEqual(json.loads(request.data)['method'], 'initialize')
                        data = {'id': 1, 'result': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'serverInfo': {'name': 'test'}}}
                    else: raise AssertionError(request.full_url)
                    return Response(json.dumps(data).encode())

            class Terminal(io.StringIO):
                def readline(self, *args): return approve
                def write(self, text):
                    if 'Save this configuration?' in text:
                        prompt_seen.append(True)
                        self_test.assertEqual(list(project.iterdir()), [])
                        self_test.assertFalse(user.exists())
                    return len(text)

            self_test = self
            original_open = open
            def fake_open(path, *args, **kwargs):
                if path == '/dev/tty': return Terminal()
                return original_open(path, *args, **kwargs)
            output = io.StringIO()
            previous = Path.cwd()
            try:
                os.chdir(project)
                with patch.dict(os.environ, env), patch('pathlib.Path.home', return_value=user), \
                     patch('urllib.request.build_opener', return_value=FakeOpener()), \
                     patch('builtins.open', side_effect=fake_open), \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    # Avoid inheriting a host-specific home override during this isolated test.
                    code = SOURCE.replace("if os.environ.get('CODEX_HOME') and", 'if False and')
                    try: exec(compile(code, 'install.sh', 'exec'), {})
                    except SystemExit as exc: status = exc.code
                    else: status = 0
                written = (user / '.codex/my-project-memory.config.toml').exists() if client == 'codex' else (project / '.claude/settings.json').exists()
                if fault or approve == 'n\n': self.assertEqual(list(project.iterdir()), [])
            finally:
                os.chdir(previous)
            self.assertNotIn('user-secret', output.getvalue())
            self.assertNotIn('gateway-secret', output.getvalue())
            self.assertNotIn('knowledge-secret', output.getvalue())
            return status, written, prompt_seen, calls

    def test_success_checks_before_approval_and_writes(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                status, written, prompts, calls = self.run_install(client=client)
                self.assertEqual(status, 0)
                self.assertTrue(written)
                self.assertTrue(prompts)
                self.assertEqual(len(calls), 6)

    def test_decline_changes_nothing(self):
        status, written, prompts, _ = self.run_install(approve='n\n')
        self.assertEqual(status, 0)
        self.assertFalse(written)
        self.assertTrue(prompts)

    def test_failures_never_prompt_or_write(self):
        for fault in ('health', 'invalid-key', 'membership', 'team-mismatch', 'mcp'):
            with self.subTest(fault=fault):
                status, written, prompts, _ = self.run_install(fault=fault)
                self.assertEqual(status, 1)
                self.assertFalse(written)
                self.assertFalse(prompts)


if __name__ == '__main__':
    unittest.main()
