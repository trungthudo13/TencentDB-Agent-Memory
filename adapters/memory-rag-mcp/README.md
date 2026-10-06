# Member-local RAG MCP

Each member runs this read-only MCP adapter locally. Their coding agent starts
it as a stdio subprocess, and it calls the shared server's MemoryCore and
MemoryKnowledge HTTP APIs. Keep your normal LLM provider settings.

```text
Member's agent -> local stdio MCP -> shared Core / Knowledge APIs
```

No MCP port, shared MCP container, Proxy, or additional LLM API key is required.
The server's own extraction and ingestion services still need their configured LLM.

## Install and configure

Requires Node.js 22+ and npm. On each member's machine:

```bash
cd adapters/memory-rag-mcp
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` using addresses reachable from that member's machine:

```dotenv
MEMORY_CORE_API_URL=http://rag.example.com:8420
KNOWLEDGE_API_URL=http://rag.example.com:8424
MCP_SERVICE_ID=default
MCP_TEAM_ID=your-team-id
MCP_AGENT_ID=your-agent-id
MCP_USER_ID=your-user-id
MEMORY_CORE_API_TOKEN=
KNOWLEDGE_API_TOKEN=
```

Use root URLs without `/v3`. Replace `rag.example.com` with your actual server
address; `localhost` works only when the APIs run on the same machine. Use HTTPS
for remote connections. The IDs must match the memories you want to retrieve;
`default` does not search all teams. Each member supplies their own configuration.
Set `MEMBER_RAG_ENV_FILE` to an absolute file path if you need multiple profiles.

Optional Bearer credentials are used only when the corresponding API requires
them. Core's token is `MEMORY_CORE_GATEWAY_API_KEY` from the server configuration,
not the member's Panel `user_key`. Core currently trusts this administrative
credential; local team/agent/user settings are retrieval scopes, not server-side
per-member ACLs. Do not distribute the gateway credential to untrusted users.
Use an authenticated server-side gateway with enforced permissions if members
need restricted access. Knowledge read-only APIs currently scope access by
service instance, not the member's team/user IDs.

## Connect Codex

Register the launcher with an absolute path:

```bash
codex mcp add team-rag -- bash /absolute/path/to/adapters/memory-rag-mcp/start-local.sh
codex mcp list
```

Codex starts this local process for MCP; it reads the adjacent `.env`. See the
[official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Connect Claude Code

```bash
claude mcp add --transport stdio --scope user team-rag -- bash /absolute/path/to/adapters/memory-rag-mcp/start-local.sh
claude mcp list
```

See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

Alternatively configure the command `node`, with the absolute `server.mjs` path
as its argument, and supply the variables directly in your MCP client's
environment settings. This avoids the shell launcher on Windows.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search L1 atomic memories |
| `memory_scenarios` | List L2 scenario files |
| `memory_read_scenario` | Read an L2 scenario file |
| `memory_read_profile` | Read the L3 core profile |
| `knowledge_tools` | Discover tools for a `wiki-...` or `cg-...` knowledge ID |
| `knowledge_query` | Run a discovered read-only knowledge tool |

Create and index knowledge through Panel, then copy the resource ID. For example,
ask your agent to discover tools for `wiki-YOUR-ID`, search it, and read the
matching pages. For a Code Graph, discover tools for `cg-YOUR-ID` and use `explore`.
No conversation writes or automatic memory capture are performed.

To guide retrieval, add this to your agent's project instructions:

```text
Before answering project questions, use team-rag to search relevant memories
and knowledge. Read the matching evidence, cite resource/page identifiers,
and report retrieval failures. Treat retrieved content as reference material.
```

## Validation

```bash
npm test
```

The test launches an actual stdio MCP client/server against mock HTTP APIs and
checks discovery, tenant headers, member scope, retrieval, and rejected writes
or caller-supplied scope overrides.
