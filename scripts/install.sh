#!/usr/bin/env bash
# Project-local MemoryProxy / Knowledge MCP configuration wizard.
# Supports: curl -fsSL <raw-url>/scripts/install.sh | bash
set +x
set -euo pipefail
umask 077

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  cat <<'EOF'
Usage: bash install.sh [project-directory]
       curl -fsSL <raw-url>/scripts/install.sh | bash -s -- [project-directory]

Configure existing Codex / Claude Code CLIs for MemoryProxy in a project.
Requires Bash, Python >= 3.11, and an interactive terminal (/dev/tty).
The wizard asks for user_key, team_id, agent_id and connection URLs.
MemoryCore URL/gateway key are used for read-only identity checks.
Checks must pass before the final confirmation; default is not to write.
Creates ~/.codex/<normalized-folder>-memory.config.toml for Codex.
Optionally configures project MCP; no launchers are needed.
It does not install CLI binaries, start services, or authenticate model accounts.
EOF
  exit 0
fi
[[ $# -le 1 ]] || { echo 'Usage: install.sh [project-directory]' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python >= 3.11 is required.' >&2; exit 1; }
python3 -c 'import tomllib' 2>/dev/null || { echo 'Python >= 3.11 is required.' >&2; exit 1; }
cd -- "${1:-.}"
exec 3<>/dev/tty || { echo 'An interactive terminal is required.' >&2; exit 1; }

section() { printf '\n  %s\n  ----------------------------------------\n' "$1" >&3; }
hint() { printf '  %s\n' "$1" >&3; }
cancel() { printf '\n  Setup cancelled.\n' >&3; exit 130; }
trap cancel INT TERM

prompt() {
  local label=$1 default=${2:-} secret=${3:-false} answer
  while true; do
    printf '  > %s' "$label" >&3
    [[ -z "$default" ]] || printf ' [%s]' "$default" >&3
    printf ': ' >&3
    if [[ "$secret" == true ]]; then
      IFS= read -r -s answer <&3 || cancel
      printf '\n' >&3
    else
      IFS= read -r answer <&3 || cancel
    fi
    answer=${answer:-$default}
    if [[ -n "$answer" ]]; then REPLY=$answer; return; fi
    hint 'Required: enter a value to continue.'
  done
}

section 'MEMORY / Project setup'
hint "Project: $PWD"
hint 'Connect an existing CLI to MemoryProxy and optional Knowledge MCP.'
hint 'Enter accepts [defaults]. Required fields have no default. Ctrl+C cancels.'
section '1 / 4  Client'
hint 'Choose one: codex or claude.'
while true; do
  prompt 'Client (codex/claude)'
  case "$REPLY" in
    codex|claude) export MI_CLIENT=$REPLY; break ;;
    *) hint 'Invalid choice. Enter codex or claude.' ;;
  esac
done
section '2 / 4  Memory identity'
hint 'Use your Memory Hub user key and team/agent IDs. Keys stay hidden.'
prompt 'user_key (hidden)' '' true; export MI_USER_KEY=$REPLY
prompt 'team_id'; export MI_TEAM=$REPLY
prompt 'agent_id'; export MI_AGENT=$REPLY
section '3 / 4  Proxy connection'
hint 'Memory instance ID is usually default; it is not your team ID.'
prompt 'MemoryProxy root URL' http://127.0.0.1:8096; export MI_PROXY=$REPLY
prompt 'Memory instance ID' default; export MI_SPACE=$REPLY
hint 'Read-only identity checks use MemoryCore, not the model API.'
prompt 'MemoryCore root URL' http://127.0.0.1:8420; export MI_CORE=$REPLY
printf '  > MemoryCore gateway key (hidden; Enter if not required): ' >&3
IFS= read -r -s MI_CORE_KEY <&3 || cancel
printf '\n' >&3
export MI_CORE_KEY
section '4 / 4  Knowledge MCP (optional)'
hint 'Adds CodeGraph/Wiki tools. The service key is separate from your user key.'
while true; do
  prompt 'Configure Knowledge MCP? (y/n)' y
  case "$REPLY" in
    y|n) export MI_MCP=$REPLY; break ;;
    *) hint 'Invalid choice. Enter y or n.' ;;
  esac
done
if [[ "$MI_MCP" == y ]]; then
  prompt 'Knowledge MCP URL' http://127.0.0.1:8421/mcp; export MI_MCP_URL=$REPLY
  prompt 'Knowledge service ID' default; export MI_SERVICE=$REPLY
  printf '  > Knowledge service key (hidden; Enter if server has no key): ' >&3
  IFS= read -r -s MI_SERVICE_KEY <&3 || cancel
  printf '\n' >&3
  export MI_SERVICE_KEY
fi

python3 <<'PY'
import datetime
import json
import os
import re
import unicodedata
from pathlib import Path
import subprocess
import shutil
import sys
import shlex
import textwrap
import tempfile
import tomllib
from urllib.parse import urlsplit, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

def value(name):
    result = os.environ.get('MI_' + name, '')
    if any(ord(c) < 32 or ord(c) == 127 for c in result):
        raise ValueError(f'{name} must not contain control characters')
    return result

def url(name):
    result = value(name).rstrip('/')
    parts = urlsplit(result)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError(f'{name} must be an HTTP(S) URL without credentials, query or fragment')
    return result

# Emit parsed TOML values without extra packages; preserve existing settings,
# including nested tables and arrays. Original formatting is kept in a backup.
def toml(v):
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool): return str(v).lower()
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return v.isoformat()
    if isinstance(v, int): return str(v)
    if isinstance(v, float): return str(v).lower()
    if isinstance(v, list): return '[' + ', '.join(toml(x) for x in v) + ']'
    if isinstance(v, dict): return '{ ' + ', '.join(toml(k) + ' = ' + toml(x) for k, x in v.items()) + ' }'
    raise ValueError('Unsupported existing TOML value')

def toml_document(data):
    """Write readable TOML sections, retaining inline tables only inside arrays."""
    lines = []
    def key(name):
        return name if re.fullmatch(r'[A-Za-z0-9_-]+', name) else toml(name)
    def section(table, parents=()):
        if parents:
            if lines: lines.append('')
            lines.append('[' + '.'.join(key(part) for part in parents) + ']')
        for name, item in table.items():
            if not isinstance(item, dict):
                lines.append(key(name) + ' = ' + toml(item))
        for name, item in table.items():
            if isinstance(item, dict): section(item, parents + (name,))
    section(data)
    return '\n'.join(lines) + '\n'

def read_json(path):
    data = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(data, dict): raise ValueError(f'{path} must contain an object')
    return data

def encoded(data): return json.dumps(data, indent=2, ensure_ascii=False) + '\n'

def atomic(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream: stream.write(content)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

class CheckFailed(Exception):
    pass

class NoRedirect(HTTPRedirectHandler):
    # Do not forward credentials to a different URL through redirects.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request_json(label, endpoint, headers=None, body=None):
    try:
        req = Request(endpoint, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type': 'application/json', **(headers or {})})
        with build_opener(NoRedirect).open(req, timeout=8) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise CheckFailed(label + ': response is too large.')
        result = json.loads(raw)
        if not isinstance(result, dict): raise ValueError()
        return result
    except HTTPError as exc:
        raise CheckFailed(label + ': HTTP ' + str(exc.code) + '. Check the URL, credentials and access.') from None
    except (URLError, TimeoutError, OSError):
        raise CheckFailed(label + ': connection failed or timed out. Check the URL and service.') from None
    except (ValueError, UnicodeError):
        raise CheckFailed(label + ': expected a JSON response. Check the endpoint.') from None

def preflight(proxy, mcp_url, mcp_headers, use_mcp):
    print('\n  CONNECTION CHECKS\n  ----------------------------------------', flush=True)
    health = request_json('MemoryProxy', proxy + '/health')
    if health.get('status') != 'ok': raise CheckFailed('MemoryProxy is not healthy.')
    print('  OK  MemoryProxy health', flush=True)
    core = url('CORE')
    core_headers = {'x-tdai-service-id': value('SPACE'), 'x-tdai-user-key': value('USER_KEY')}
    if value('CORE_KEY'): core_headers['Authorization'] = 'Bearer ' + value('CORE_KEY')
    def meta(route, body, label):
        result = request_json(label, core + '/v3/meta/' + route, core_headers, body)
        if result.get('code') != 0 or not isinstance(result.get('data'), dict):
            raise CheckFailed(label + ': request was rejected. Check the identity and access.')
        return result['data']
    identity = meta('auth/verify', {'user_key': value('USER_KEY')}, 'User key')
    user_id = (identity.get('user') or {}).get('user_id')
    if identity.get('valid') is not True or not isinstance(user_id, str) or not user_id:
        raise CheckFailed('User key is invalid or the user is not visible.')
    print('  OK  User key verified (user_id resolved)', flush=True)
    team = meta('team/get', {'team_id': value('TEAM')}, 'Team')
    if team.get('team_id') != value('TEAM') or team.get('status') != 'active':
        raise CheckFailed('Team is missing or inactive.')
    member = meta('team-member/get', {'team_id': value('TEAM'), 'user_id': user_id}, 'Team membership')
    if member.get('team_id') != value('TEAM') or member.get('user_id') != user_id or member.get('status') != 'active':
        raise CheckFailed('User is not an active member of this team.')
    print('  OK  Active team membership', flush=True)
    agent = meta('agent/get', {'agent_id': value('AGENT')}, 'Agent')
    if agent.get('agent_id') != value('AGENT') or agent.get('team_id') != value('TEAM') or agent.get('status') != 'active':
        raise CheckFailed('Agent is missing, inactive, or belongs to a different team.')
    if agent.get('owner_user_id') != user_id:
        raise CheckFailed('Agent belongs to another user; proxy selection requires your own agent.')
    print('  OK  Agent belongs to this user and team', flush=True)
    if use_mcp:
        result = request_json('Knowledge MCP', mcp_url,
            {'Accept': 'application/json, text/event-stream', **mcp_headers},
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': '2025-03-26', 'capabilities': {},
                'clientInfo': {'name': 'memory-install-check', 'version': '1.0'}}})
        init = result.get('result')
        if result.get('error') or result.get('id') != 1 or not isinstance(init, dict) or not init.get('protocolVersion') or not isinstance(init.get('capabilities'), dict) or not isinstance(init.get('serverInfo'), dict):
            raise CheckFailed('Knowledge MCP initialization failed. Check endpoint, service ID and service key.')
        print('  OK  Knowledge MCP handshake', flush=True)
    print('  Model authentication and asset queries are not tested.', flush=True)

try:
    proxy = url('PROXY')
    space = quote(value('SPACE'), safe='')
    headers = {'x-tdai-user-key': value('USER_KEY'), 'x-team-id': value('TEAM'), 'x-agent-id': value('AGENT')}
    use_mcp = value('MCP') == 'y'
    mcp_headers = {'x-tdai-service-id': value('SERVICE')}
    if value('SERVICE_KEY'): mcp_headers['Authorization'] = 'Bearer ' + value('SERVICE_KEY')
    mcp_url = url('MCP_URL') if use_mcp else ''
    files = []
    results = []
    backups = []
    warnings = []
    if value('CLIENT') == 'codex':
        normalized = unicodedata.normalize('NFKD', Path.cwd().name.lower().replace('đ', 'd'))
        slug = re.sub(r'[^a-z0-9]+', '-', normalized.encode('ascii', 'ignore').decode()).strip('-') or 'project'
        profile = slug + '-memory'
        codex_dir = Path.home() / '.codex'
        if os.environ.get('CODEX_HOME') and Path(os.environ['CODEX_HOME']).expanduser().resolve() != codex_dir.resolve():
            raise ValueError('Unset custom CODEX_HOME before installing a profile in ~/.codex')
        path = codex_dir / (profile + '.config.toml')
        owner = '# Memory installer project: ' + json.dumps(str(Path.cwd()))
        original = path.read_text() if path.exists() else ''
        data = tomllib.loads(original) if original else {}
        data.update(model_provider='memory_proxy')
        provider = data.setdefault('model_providers', {}).setdefault('memory_proxy', {})
        provider.update(name='Local MemoryProxy', base_url=proxy + '/codex/' + space + '/v1', wire_api='responses', requires_openai_auth=True, supports_websockets=False, stream_idle_timeout_ms=120000)
        provider.setdefault('http_headers', {}).update(headers)
        content = owner + '\n' + toml_document(data)
        tomllib.loads(content)
        files.append((path, content, 0o600))
        if use_mcp:
            path = Path('.codex/config.toml')
            data = tomllib.loads(path.read_text()) if path.exists() else {}
            data.setdefault('mcp_servers', {})['memory_knowledge'] = {'url': mcp_url, 'http_headers': mcp_headers}
            content = toml_document(data)
            tomllib.loads(content)
            files.append((path, content, 0o600))
    if value('CLIENT') == 'claude':
        path = Path('.claude/settings.json')
        data = read_json(path)
        env = data.setdefault('env', {})
        before = encoded(data)
        intended_env = {'ANTHROPIC_BASE_URL': proxy + '/claude-code/' + space,
                        'ANTHROPIC_CUSTOM_HEADERS': '\n'.join(k + ': ' + v for k, v in headers.items())}
        if any(key in env and env[key] != val for key, val in intended_env.items()):
            warnings.append('Existing Claude proxy options differ from the checked inputs and will be kept. Edit them manually to use the checked values.')
        env.setdefault('ANTHROPIC_BASE_URL', proxy + '/claude-code/' + space)
        env.setdefault('ANTHROPIC_CUSTOM_HEADERS', '\n'.join(k + ': ' + v for k, v in headers.items()))
        if not path.exists() or encoded(data) != before:
            files.append((path, encoded(data), 0o600))
        else:
            results.append(('Kept', str(path) + ' (existing options)'))
        if use_mcp:
            path = Path('.mcp.json')
            data = read_json(path)
            before = encoded(data)
            intended_mcp = {'type': 'http', 'url': mcp_url, 'headers': mcp_headers}
            if 'memory_knowledge' in data.get('mcpServers', {}) and data['mcpServers']['memory_knowledge'] != intended_mcp:
                warnings.append('Existing Claude MCP settings differ from the checked endpoint and will be kept; that existing connection was not tested.')
            data.setdefault('mcpServers', {}).setdefault('memory_knowledge', {'type': 'http', 'url': mcp_url, 'headers': mcp_headers})
            if not path.exists() or encoded(data) != before:
                files.append((path, encoded(data), 0o600))
            else:
                results.append(('Kept', str(path) + ' (memory_knowledge already exists)'))
    # Validate all existing configs before writing. Exclude secrets and backups
    # even when this directory is not yet a Git repository.
    ignore = Path('.gitignore')
    if ignore.is_symlink(): raise ValueError('Refusing symlink .gitignore')
    old_ignore = ignore.read_text() if ignore.exists() else ''
    patterns = ['/' + str(p) + suffix for p, _, _ in files if not p.is_absolute() for suffix in ('', '.bak.*')]
    missing = [p for p in patterns if p not in old_ignore.splitlines()]
    # Ignoring a tracked credential file does not protect it: fail before writes.
    for path, _, _ in files:
        if not path.is_absolute() and shutil.which('git') and subprocess.run(['git', 'ls-files', '--error-unmatch', '--', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise ValueError(f'{path} is tracked by Git; untrack it before installing private configuration')
    for path, _, _ in files:
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise ValueError(f'Refusing symlink destination: {path}')
    # Network checks and approval happen before the first filesystem mutation.
    preflight(proxy, mcp_url, mcp_headers, use_mcp)
    print('\n  READY TO INSTALL\n  ----------------------------------------')
    for path, _, _ in files: print('  Write: ' + str(path))
    for action, target in results: print('  ' + action + ': ' + target)
    if missing: print('  Update: .gitignore (private config exclusions)')
    if warnings:
        print('\n  Warnings before approval')
        for warning in warnings: print('  ! ' + warning)
    sys.stdout.flush()
    with open('/dev/tty', 'r+') as tty:
        while True:
            tty.write('\n  > Save this configuration? (y/n) [n]: ')
            tty.flush()
            answer = tty.readline()
            if not answer or answer.strip().lower() in ('', 'n', 'no'):
                print('\n  Cancelled. No configuration files were changed.')
                raise SystemExit(0)
            if answer.strip().lower() in ('y', 'yes'): break
            tty.write('  Enter y or n.\n')
    if missing:
        results.append(('Updated' if ignore.exists() else 'Created', str(ignore) + ' (private config exclusions)'))
        atomic(ignore, old_ignore.rstrip('\n') + '\n\n# Private Memory client configuration\n' + '\n'.join(missing) + '\n', 0o644)
    stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S%f')
    for path, content, mode in files:
        exists = path.exists()
        if exists and path.read_text() == content:
            results.append(('Kept', str(path) + ' (already up to date)'))
            continue
        if exists:
            backup = path.with_name(path.name + '.bak.' + stamp)
            atomic(backup, path.read_text())
            backups.append(str(backup))
        atomic(path, content, mode)
        results.append(('Updated' if exists else 'Created', str(path)))

    # Keep the completion summary distinct, including on narrow terminals.
    box_width = max(20, min(96, shutil.get_terminal_size((80, 24)).columns - 6))
    border = '  +' + '-' * (box_width + 2) + '+'
    def box_line(text=''):
        wrapped = textwrap.wrap(text, width=box_width, subsequent_indent='  ',
                                replace_whitespace=False, break_on_hyphens=False) or ['']
        for line in wrapped:
            print('  | ' + line.ljust(box_width) + ' |')
    print('\n' + border)
    box_line('SETUP COMPLETE')
    print(border)
    box_line('Changes')
    box_line()
    for action, target in results:
        box_line(action.ljust(8) + ' ' + target)
    print(border)
    print('\n  Next steps\n  ----------------------------------------')
    print('  Run from the project directory:')
    print('\n    cd ' + shlex.quote(str(Path.cwd())))
    if value('CLIENT') == 'codex':
        print('    codex --profile ' + profile)
    else:
        print('    claude')
    if use_mcp:
        print('\n  In the client: /mcp to check the Knowledge connection.')
    print('  Send a message, then check Memory Hub under your team/agent.')
    print('\n  Backups\n  ----------------------------------------')
    if backups:
        for backup in backups: print('    ' + backup)
    else:
        print('  None needed. No existing configuration file was changed.')
    print('\n  Updating later\n  ----------------------------------------')
    print('  Rerun the same installer from this project.')
    if value('CLIENT') == 'codex':
        print('  MemoryProxy values are updated; other profile settings are preserved.')
    else:
        print('  Only missing options are added. Edit existing values in:')
        print('    .claude/settings.json')
        if use_mcp: print('    .mcp.json')
    print('\n  Notes\n  ----------------------------------------')
    print('  Entered URLs, Memory identity and optional MCP handshake passed checks.')
    print('  Model authentication and Knowledge asset queries were not tested.')
    print('  Keep your model login separate from your Memory user key.')
    if value('CLIENT') == 'claude' and Path('.claude/settings.local.json').exists():
        warnings.append('.claude/settings.local.json may override these proxy settings. Review its env options.')
    if Path('.memory-clients').exists() or Path('.codex-local').exists():
        warnings.append('Legacy launcher/home files remain. Use the command under Next steps.')
    if not shutil.which(value('CLIENT')):
        warnings.append(value('CLIENT') + ' CLI is not on PATH. Install it before running the command above.')
    sys.stdout.flush()
    if warnings:
        print('\n  Warnings\n  ----------------------------------------', file=sys.stderr)
        for warning in warnings: print('  ! ' + warning, file=sys.stderr)
except CheckFailed as exc:
    print('\n  CHECK FAILED\n  ----------------------------------------', file=sys.stderr)
    print('  ' + str(exc), file=sys.stderr)
    print('  No configuration files were changed. Correct the inputs and rerun.', file=sys.stderr)
    raise SystemExit(1)
except (ValueError, TypeError, AttributeError, OSError) as exc:
    # Parse errors may contain source text; never print potentially secret input.
    sys.stdout.flush()
    print('\n  SETUP FAILED\n  ----------------------------------------', file=sys.stderr)
    print('  ' + type(exc).__name__ + ': configuration could not be completed.', file=sys.stderr)
    print('  Check URLs, JSON/TOML syntax, file permissions, symlinks and tracked config files.', file=sys.stderr)
    raise SystemExit(1)
PY

