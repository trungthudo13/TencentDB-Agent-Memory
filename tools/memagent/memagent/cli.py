"""Merge MemoryProxy settings without replacing unrelated agent configuration."""

import argparse
from collections.abc import MutableMapping
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import quote, urlsplit

import tomlkit


def header_value(value):
    if not value.strip() or any(ord(c) < 32 or ord(c) > 126 for c in value):
        raise argparse.ArgumentTypeError("must be a non-empty printable ASCII value")
    return value


def proxy_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise argparse.ArgumentTypeError("expected an http(s) proxy URL without credentials, query or fragment")
    return value.rstrip("/")


def mapping(parent, key):
    if key not in parent:
        parent[key] = {}
    result = parent[key]
    if not isinstance(result, MutableMapping):
        raise ValueError(f"configuration field {key} must be an object/table")
    return result


def replace_headers(headers, values):
    for key in list(headers):
        if key.lower() in values:
            del headers[key]
    headers.update(values)


def configure_codex(content, args, base):
    doc = tomlkit.parse(content)
    doc["model_provider"] = "memory_proxy"
    provider = mapping(mapping(doc, "model_providers"), "memory_proxy")
    provider.update({
        "name": "MemoryProxy", "base_url": f"{base}/codex/{quote(args.service_id, safe='')}/v1",
        "wire_api": "responses", "requires_openai_auth": True,
        "supports_websockets": False, "stream_idle_timeout_ms": 120000,
    })
    # Memory identity is separate from the user's existing OpenAI login.
    for key in ("experimental_bearer_token", "env_key", "env_key_instructions"):
        provider.pop(key, None)
    values = {"x-tdai-user-key": args.user_key, "x-team-id": args.team_id, "x-agent-id": args.agent_id}
    env_headers = mapping(provider, "env_http_headers")
    for key in list(env_headers):
        if key.lower() in values:
            del env_headers[key]
    replace_headers(mapping(provider, "http_headers"), values)
    return tomlkit.dumps(doc)


def configure_claude(content, args, base):
    doc = json.loads(content) if content.strip() else {}
    if not isinstance(doc, dict):
        raise ValueError("settings.json must contain an object")
    env = mapping(doc, "env")
    existing = env.get("ANTHROPIC_CUSTOM_HEADERS", "")
    if not isinstance(existing, str):
        raise ValueError("ANTHROPIC_CUSTOM_HEADERS must be a string")
    managed = {"x-team-id", "x-agent-id", "x-tdai-user-key"}
    lines = [line for line in existing.splitlines()
             if line.strip() and line.partition(":")[0].strip().lower() not in managed]
    lines.extend([f"x-team-id: {args.team_id}", f"x-agent-id: {args.agent_id}",
                  f"x-tdai-user-key: {args.user_key}"])
    env.update({
        "ANTHROPIC_BASE_URL": f"{base}/claude-code/{quote(args.service_id, safe='')}",
        "ANTHROPIC_AUTH_TOKEN": args.user_key,
        "ANTHROPIC_CUSTOM_HEADERS": "\n".join(lines),
    })
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def write_config(path, content):
    """Atomic owner-only write; retain a private copy of the previous config."""
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        fd, name = tempfile.mkstemp(prefix=path.name + ".bak-", dir=path.parent)
        backup = Path(name)
        with os.fdopen(fd, "wb") as stream:
            stream.write(path.read_bytes())
    fd, name = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
    return backup


def main(argv=None):
    parser = argparse.ArgumentParser(prog="memagent")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Configure an agent to use MemoryProxy")
    for name in ("user_key", "agent_id", "team_id"):
        init.add_argument("--" + name.replace("_", "-"), "--" + name,
                          dest=name, required=True, type=header_value)
    init.add_argument("--platform", required=True, choices=("codex", "claude"))
    init.add_argument("--proxy-url", type=proxy_url, default="http://127.0.0.1:8096")
    init.add_argument("--service-id", type=header_value, default="default")
    init.add_argument("--home", type=Path, default=Path.home(),
                      help="Directory containing .codex/.claude (default: user home)")
    args = parser.parse_args(argv)
    relative = ".codex/config.toml" if args.platform == "codex" else ".claude/settings.json"
    path = args.home.expanduser() / relative
    try:
        if path.is_symlink():
            raise ValueError("target configuration is a symlink; use its actual directory")
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        configure = configure_codex if args.platform == "codex" else configure_claude
        try:
            updated = configure(content, args, args.proxy_url)
        except Exception:
            # Parser errors can contain source lines, including credentials.
            raise ValueError("invalid configuration structure or syntax; file left unchanged") from None
        if updated == content:
            print(f"Already configured: {path}")
            return 0
        backup = write_config(path, updated)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"memagent: {exc}\n")
    print(f"Configured: {path}")
    if backup:
        print(f"Backup: {backup}")
    print("Start a new agent session to apply settings.")
    return 0
