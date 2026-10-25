"""Exercise installed hook processes with real lifecycle payloads and isolated state."""
import ast
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_install import SOURCE

HOOK = next(ast.literal_eval(n.value) for n in ast.parse(SOURCE).body
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'HOOK_SOURCE' for t in n.targets))


class ContextHooks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.script = self.root / 'context-hook.py'
        self.script.write_text(HOOK)
        self.policy()

    def policy(self, mode='strict', ids=True, reverse=False):
        (self.root / 'context.toml').write_text(
            f'mode = "{mode}"\ncode_graph_ids = ' + ('["cg-test"]' if ids else '[]')
            + '\nwiki_ids = ' + ('["wiki-test"]' if ids else '[]')
            + '\norder = ' + ('["wiki", "code"]' if reverse else '["code", "wiki"]'))

    def event(self, event, **kwargs):
        p = subprocess.run([sys.executable, str(self.script)], input=json.dumps({
            'hook_event_name': event, 'session_id': 's1', **kwargs}),
            text=True, capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)['hookSpecificOutput'] if p.stdout else {}

    def local(self, session='s1'):
        return self.event('PreToolUse', session_id=session, tool_name='Bash', tool_input={'command': 'rg hooks'})

    def retrieve(self, kind, ident, success=True, call='c1', post=True):
        args = dict(tool_name='mcp__memory_knowledge__' + ('code_explore' if kind == 'code' else 'wiki_search'),
                    tool_use_id=call, tool_input={('code_graph_id' if kind == 'code' else 'wiki_id'): ident, 'query': 'installer hooks'})
        pre = self.event('PreToolUse', **args)
        if post:
            self.event('PostToolUse', **args, tool_response={'content': [], 'isError': not success})
        return pre, args

    def test_order_success_reset_and_session_isolation(self):
        self.event('UserPromptSubmit')
        self.assertEqual(self.local()['permissionDecision'], 'deny')
        pre, _ = self.retrieve('wiki', 'wiki-test')
        self.assertEqual(pre['permissionDecision'], 'deny')
        self.retrieve('code', 'cg-test')
        self.assertEqual(self.local()['permissionDecision'], 'deny')
        self.retrieve('wiki', 'wiki-test', call='c2')
        self.assertNotIn('permissionDecision', self.local())
        self.assertEqual(self.local('other')['permissionDecision'], 'deny')
        self.event('UserPromptSubmit')
        self.assertEqual(self.local()['permissionDecision'], 'deny')

    def test_failed_or_wrong_asset_does_not_unlock(self):
        self.retrieve('code', 'cg-test', success=False)
        self.retrieve('code', 'cg-wrong')
        self.assertEqual(self.local()['permissionDecision'], 'deny')

    def test_stale_completion_and_forged_post_do_not_unlock(self):
        _, args = self.retrieve('code', 'cg-test', post=False)
        self.event('UserPromptSubmit')
        self.event('PostToolUse', **args, tool_response={'isError': False})
        pre, _ = self.retrieve('wiki', 'wiki-test')
        self.assertEqual(pre['permissionDecision'], 'deny')

    def test_policy_reload_and_modes(self):
        self.retrieve('code', 'cg-test')
        self.retrieve('wiki', 'wiki-test')
        self.policy(reverse=True)
        self.assertEqual(self.local()['permissionDecision'], 'deny')
        pre, _ = self.retrieve('code', 'cg-test')
        self.assertEqual(pre['permissionDecision'], 'deny')
        self.policy(mode='advisory')
        self.assertNotIn('permissionDecision', self.local())
        self.policy(mode='off')
        self.assertEqual(self.local(), {})

    def test_empty_or_invalid_policy_is_visible_and_closed(self):
        self.policy(ids=False)
        self.assertIn('NOT CONFIGURED', self.event('SessionStart')['additionalContext'])
        self.assertEqual(self.local()['permissionDecision'], 'deny')
        (self.root / 'context.toml').write_text('invalid toml = [')
        self.assertEqual(self.local()['permissionDecision'], 'deny')

    def test_status_is_not_retrieval_and_no_query_text_is_persisted(self):
        self.event('PostToolUse', tool_name='mcp__memory_knowledge__code_status',
                   tool_response={'isError': False}, tool_input={'code_graph_id': 'cg-test'})
        self.assertEqual(self.local()['permissionDecision'], 'deny')
        self.retrieve('code', 'cg-test', post=False)
        for p in (self.root / 'state').glob('*.json'):
            self.assertNotIn('installer hooks', p.read_text())


if __name__ == '__main__':
    unittest.main()
