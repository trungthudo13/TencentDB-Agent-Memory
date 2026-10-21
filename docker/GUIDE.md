# Docker deployment

## MemoryAcp: use a Codex subscription for L1 — step by step

This guide connects **MemoryCore → MemoryAcp → Codex** for L1 memory extraction
and deduplication. Run all commands below from the **repository root**
(the directory containing `docker/`, `MemoryCore/`, and `MemoryAcp/`).

| Component | Purpose |
| --- | --- |
| `memory` | MemoryCore: receives conversations and processes memory |
| `memory-acp` | Bridge that calls Codex using ChatGPT authentication |
| `mongodb` | Stores memory data |
| `memory-proxy` | Captures coding-client conversations as L0; configured separately in the next section |

Only **L1** uses ACP. **L2/L3, skills, and Knowledge** still use the provider
configured in `MEMORY_LLM_*`. MemoryAcp does not automatically capture
conversations from Codex on your computer.

### Step 1 — Check Docker and prepare the configuration

```bash
docker --version
docker compose version
```

Both commands must succeed. Docker Engine or Docker Desktop must be running.

If `docker/.env` does not exist, create it from the example. This command
preserves an existing file:

```bash
if [ ! -f docker/.env ]; then
  cp docker/.env.example docker/.env
fi
```

Open `docker/.env` in an editor and fill in the required deployment settings,
especially `TDAI_PASSWORD_PEPPER` and `MEMORY_CORE_GATEWAY_API_KEY`.
Keep existing secrets unchanged if the deployment already contains data.

Check or add the following variables. Each variable name should appear only once:

```dotenv
MEMORY_L1_ACP_BASE_URL=http://memory-acp:8097/v1
MEMORY_L1_ACP_MODEL=codex
MEMORY_ACP_TOKEN=
MEMORY_ACP_PORT=8097
MEMORY_ACP_TIMEOUT_MS=120000
MEMORY_ACP_MAX_QUEUE=8
```

- `memory-acp` in the URL is the service name on the Docker network, not `localhost`.
- `codex` selects the adapter's default model. A specific model must match an ID
  supported by the adapter.
- Leaving `MEMORY_ACP_TOKEN` empty makes Compose reuse
  `MEMORY_CORE_GATEWAY_API_KEY` to authenticate bridge requests. You can set a
  dedicated secret instead. This is an **internal secret**, not an OpenAI API key
  or a ChatGPT login token.
- Do not point the global `MEMORY_LLM_BASE_URL` at ACP. Configure `MEMORY_LLM_*`
  for L2/L3, skills, and Knowledge; `REPLACE_ME` is not a usable provider setting.

Validate the Compose configuration without printing secrets:

```bash
docker compose -f docker/docker-compose.yml config --quiet
```

**Expected result:** the command exits without errors. If a required variable
is missing, fill in the variable named in the error and run the command again.

### Step 2 — Build and start the required services

```bash
docker compose -f docker/docker-compose.yml up -d --build memory-acp memory
docker compose -f docker/docker-compose.yml ps
```

Compose also starts MongoDB because MemoryCore depends on it.
The first build may take several minutes to download images and install dependencies.

**Expected result:** `memory-acp`, `memory`, and `mongodb` all show
`Up ... (healthy)`. If a service is still `starting`, run `ps` again shortly.
This command does not start Panel, Knowledge, or the proxy.

### Step 3 — Sign in to ChatGPT for Codex inside the container

```bash
docker compose -f docker/docker-compose.yml exec memory-acp \
  env CODEX_HOME=/data/codex /app/node_modules/.bin/codex login --device-auth
```

1. Keep this terminal open.
2. Open the URL displayed by Codex in your browser.
3. Sign in with a ChatGPT account that has Codex access and enter the code shown in the terminal.
4. Complete the browser confirmation and wait for the terminal to report a successful login.

Do not paste tokens or authentication-file contents into `.env`.
Signing in to Codex on the host **does not sign in this container automatically**.

Check the login status:

```bash
docker compose -f docker/docker-compose.yml exec memory-acp \
  env CODEX_HOME=/data/codex /app/node_modules/.bin/codex login status
```

**Expected result:** Codex reports that it is signed in with ChatGPT.
Login state is stored in the `acp-codex-auth` volume, so normal container restarts
or recreation preserve it. Avoid `down -v` if you want to keep your data and login.

### Step 4 — Check that the bridge is running

```bash
curl -fsS http://127.0.0.1:8097/health
```

If you changed `MEMORY_ACP_PORT`, replace `8097` with your configured port.
A typical response is:

```json
{"status":"ok","active":false,"queued":0,"authentication":"not_checked"}
```

`authentication: "not_checked"` is normal: this endpoint checks only the HTTP
service and queue. It **does not confirm that Codex can call a model**.
Continue to step 5 for an end-to-end check.

### Step 5 — Send a test request from MemoryCore through ACP

Copy the entire block below, including both lines containing `NODE`. It reads
the secret inside the container without requiring you to enter or print it.
This sends a test prompt and, if successful, uses some Codex quota from the
account you signed in with.

```bash
docker compose -f docker/docker-compose.yml exec -T memory \
  node --import tsx --input-type=module <<'NODE'
import { createAcpL1Runner } from './src/adapters/standalone/acp-llm-runner.ts';

try {
  const runner = createAcpL1Runner();
  if (!runner) throw new Error('L1 ACP is not enabled. Check MEMORY_L1_ACP_BASE_URL.');
  const answer = await runner.run({
    taskId: 'l1-acp-connectivity-check',
    systemPrompt: 'Return only the requested short answer.',
    prompt: 'Reply with exactly OK.',
    timeoutMs: 120000,
  });
  console.log('MemoryCore → MemoryAcp → Codex: success');
  console.log('Model response:', answer);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
```

**Expected result:** a `success` message followed by the model's response,
typically `OK`. This confirms that Docker networking, internal authentication,
the L1 runner, and the Codex login work together.

The test does not write L0/L1 records to the database. To create real memories,
you need L0 conversations with valid identities and an enabled L1 pipeline.
See **MemoryProxy** below to configure conversation capture. Enabling ACP does
not automatically enable capture or injection.

### Step 6 — Apply configuration changes and troubleshoot

After changing variables in `docker/.env`, run:

```bash
docker compose -f docker/docker-compose.yml up -d memory-acp memory
```

A plain `restart` does not update the container's environment. If you changed
source code, add `--build` to the command above.

Inspect service status and logs:

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail=100 memory-acp memory
```

| Symptom | Resolution |
| --- | --- |
| `503` / `auth_required` | Repeat step 3 and check `login status`. The bridge accepts only ChatGPT authentication. |
| `401 Unauthorized` | Ensure both services receive the same `MEMORY_ACP_TOKEN` or gateway key. Run `up -d memory-acp memory` after editing `.env`. |
| `400` / `invalid_model` | Set `MEMORY_L1_ACP_MODEL=codex` to use the default model, recreate `memory`, and retry. |
| `400` / `unsupported_parameter` | The bridge does not yet accept tools, streaming, `response_format`, or OpenAI generation parameters. Use the dedicated L1 runner; do not point the global LLM URL at the bridge. |
| `429` / `queue_full` | The bridge queue is full. Reduce concurrent work or adjust `MEMORY_ACP_MAX_QUEUE`. |
| `504` or a timeout | Check networking, quota, and Codex status. You can increase `MEMORY_ACP_TIMEOUT_MS` and recreate both services. |
| `502` / `acp_error` | Check the login, model, and network connection. The adapter intentionally withholds raw errors that may contain sensitive data. |
| `Connection refused` / `fetch failed` | Check that the service is healthy and the internal URL is `http://memory-acp:8097/v1`. Changing the host port does not change the internal Docker port. |
| Healthy services but no L1 records | Run step 5, then check L0 capture, identities, and the pipeline. Health checks do not validate login or memory data. |
| L1 works but L2/L3 or Knowledge fails | Configure a valid provider in `MEMORY_LLM_*`; these tasks do not use ACP yet. |

Current limits: text-only, non-streaming requests; no automatic fallback to a
paid API when Codex fails. ACP manages its own output budget, so L1's
`maxTokens` setting is not enforced. Incomplete answers are rejected before L1
parsing, and token credits are not estimated for ACP calls.

### Step 7 — Disable ACP for L1 and restore the previous provider

In `docker/.env`, set the URL to an empty string:

```dotenv
MEMORY_L1_ACP_BASE_URL=
```

Then apply the change:

```bash
docker compose -f docker/docker-compose.yml up -d memory
```

L1 returns to MemoryCore's regular runner/provider. The `MEMORY_LLM_*` provider
must be valid for processing to continue. This preserves the database and
Codex login volume; no container or volume deletion is needed.

## MemoryProxy

Build and start only the proxy from the repository root:

```bash
docker compose -f docker/docker-compose.yml up -d --build --no-deps memory-proxy
curl -fsS http://127.0.0.1:8096/health
docker compose -f docker/docker-compose.yml logs --tail=50 memory-proxy
```

The service builds the local `MemoryProxy/` source, mounts
`docker/memory-proxy.yaml` read-only, and persists SQLite state in `proxy-data`.
It binds to `127.0.0.1:8096` independently of the other services' `BIND_ADDRESS`.
Optional `.env` overrides are `PROXY_BIND_ADDRESS`, `PROXY_PORT`, and
`PROXY_UPSTREAM_URL`. Defaults work without adding anything to an existing `.env`.
The upstream defaults to `https://chatgpt.com/backend-api/codex`; the proxy has
no LLM API key and preserves the caller's upstream credential.

This initial deployment starts the existing API reverse proxy. It is **not** a
CONNECT forward proxy and is not configured through `HTTP_PROXY`/`HTTPS_PROXY`.
Starting the container does not reroute Codex automatically or change its login.
The existing Codex POST route is `/codex/default/v1/responses` (also accepted
without `/v1`), forwarded to the upstream's `/responses` endpoint.

**Current limits:** MemoryCore authentication, session initialization, memory
injection, and extraction are explicitly disabled. ChatGPT tokens cannot be
used as MemoryCore user keys; configure the separate header below before
enabling capture. The existing Codex handler supports
HTTP/SSE; this deployment does not add WebSocket forwarding or the model-list
routes needed for a complete Codex gateway. Do not treat a successful `/health`
check as proof of authenticated Codex compatibility or memory capture.

Because gateway authentication is disabled, keep the loopback binding for this
initial setup. The upstream must still authenticate each model request.
`/health` reports process/storage health, not a successful model call.

### Separate Memory identity from model authentication

Codex and Claude Code requests may carry both credentials:

```http
Authorization: Bearer <model-login-token>
x-tdai-user-key: <Memory-Hub-user-key>
```

The proxy uses `x-tdai-user-key` for MemoryCore verification, session setup,
capabilities, and memory operations. It removes this header before forwarding
to the model and preserves the model's own authentication. When the header is
absent, legacy clients can still supply their Memory key in their original
authentication header. An explicitly empty header does not fall back.

For Codex, add this under the existing provider in user-level `config.toml`:

```toml
[model_providers.memory_proxy.env_http_headers]
x-tdai-user-key = "MEMORY_USER_KEY"
```

Set `MEMORY_USER_KEY` in the environment of the process launching Codex, using
your own Memory Hub user key, then start a new session. Keep
`requires_openai_auth = true`; do not replace the ChatGPT token with this key.
For Claude Code, the same header can be supplied via `ANTHROPIC_CUSTOM_HEADERS`;
keep the existing subscription login instead of setting `ANTHROPIC_AUTH_TOKEN`.

The separate internal gateway credential is `MEMORY_CORE_GATEWAY_API_KEY` from
`docker/.env`. Compose passes it to the proxy; the YAML references it through
`auth.serviceToken`, `tdai.apiKey`, and `skill.serviceToken`. It is never sent
to the model. After changing `.env`, recreate the proxy container.

To enable L0 capture after clients have their user keys, set `auth.enabled`,
`sessionInit.enabled`, `extraction.enabled`, and `tdai.enabled` to `true` in
`memory-proxy.yaml`, and set `extraction.extractors: [tdai-memory]` for L0 only.
The nested `tdai.memory.enabled` and `writeL0` flags are already prepared.
Restart the proxy, open a new agent session, and complete team/agent/task
selection (Codex needs Plan mode for the selection form). Missing or bypassed
session identity means L0 capture is skipped. Memory injection is a separate
feature and remains disabled in this setup.

## MemoryKnowledge MCP over Streamable HTTP

The `knowledgebase` service exposes MCP at **`http://127.0.0.1:8421/mcp`**
in the existing HTTP process. No extra container or port is needed. From the
repository root, after preparing `docker/.env`:

```bash
docker compose -f docker/docker-compose.yml up -d --build knowledgebase
curl -fsS http://127.0.0.1:8421/health
```

Configure the Agent's MCP client with transport **Streamable HTTP**, that URL,
and header `x-tdai-service-id: default` (or the tenant containing your assets).
When `KNOWLEDGE_SERVICE_KEY` is configured, every MCP request also requires
`Authorization: Bearer <service key>`. This is an internal service credential,
not a Memory user key or model login token. The service ID selects a tenant
within that shared trusted credential; MCP does not enforce per-user ACLs.

`KNOWLEDGE_MCP_ENABLED` defaults to `true`; set it to `false` to disable `/mcp`.
`KNOWLEDGE_MCP_ALLOWED_ORIGINS` accepts comma-separated exact browser origins.
The default empty list rejects requests carrying any `Origin`; native clients
without `Origin` are accepted. This validates Origin only; it does not enable
browser CORS/OPTIONS. Apply environment changes with `up -d knowledgebase`.

This endpoint uses stateless JSON responses. GET/DELETE return 405 after access
checks; it does not provide SSE notifications or resumable sessions. Use a
Streamable HTTP client, not an older HTTP+SSE-only client.
See [the MCP connection guide](../MemoryKnowledge/MCP.md) for the 12 CodeGraph/Wiki
tools, connection checks, troubleshooting, and the local stdio alternative.

## Initialize the first admin with Docker

Run these commands in Bash from the repository root. This guide uses
`docker/docker-compose.yml` and its `memory` service.

`init-admin` creates the first administrator in an empty metadata database.
Run it once per new database, not on every restart. Existing users and keys
persist in the Docker volumes.

## 1. Start the services

If you have not configured the deployment yet, copy `docker/.env.example` to
`docker/.env` and fill in the required values. Keep an existing `.env` file.

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
```

Wait for the `memory` service to become healthy.

## 2. Understand the two keys

| Key | Purpose | Location |
| --- | --- | --- |
| Gateway key | Authenticates API requests using `Authorization: Bearer ...` | `MEMORY_CORE_GATEWAY_API_KEY` in `docker/.env` |
| User key | Identifies a user and signs in to the Panel | Generated by MemoryCore when the user is created |

Compose maps the gateway key to a different environment variable inside the
`memory` container:

```yaml
TDAI_GATEWAY_API_KEY: ${MEMORY_CORE_GATEWAY_API_KEY:-}
```

You do not need to add `TDAI_GATEWAY_API_KEY` to `.env`. The command below reads
it directly from the running container and includes the Bearer header when
it is nonempty. If you change `.env`, run `docker compose -f
docker/docker-compose.yml up -d` to apply the change; a container restart
alone does not update its environment.

## 3. Create the admin and verify its User key

Copy and run the entire block, including both `NODE` lines. Node.js is already
available inside the `memory` container; no host-side Node.js or `jq` is needed.

```bash
docker compose -f docker/docker-compose.yml exec -T memory node --input-type=module <<'NODE'
const headers = {
  'Content-Type': 'application/json',
  'x-tdai-service-id': 'default',
};
const gatewayKey = process.env.TDAI_GATEWAY_API_KEY;
if (gatewayKey) headers.Authorization = `Bearer ${gatewayKey}`;

async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:8420${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  }
  return result.data;
}

try {
  const admin = await post('/v3/internal/meta/user/init-admin', {
    username: 'admin',
  });
  // Print the generated key before verification so it remains available
  // even if the verification request fails.
  console.log('Admin created. Save this User key now:');
  console.log(admin.user_key);
  const verified = await post('/v3/meta/auth/verify', {
    user_key: admin.user_key,
  });
  if (!verified.valid) throw new Error('User key verification returned valid=false');
  console.log('User key verified: valid=true');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
```

The initialization request is:

```http
POST /v3/internal/meta/user/init-admin
Content-Type: application/json
x-tdai-service-id: default
Authorization: Bearer <gateway key, when configured>

{"username":"admin"}
```

The generated login key is returned in **`data.user_key`**, not
`data.default_user_key`. It starts with `sk-mem-`. Save it in a password manager.
The command above prints the key but does not automatically write a key file.

## 4. Sign in

Open <http://localhost:8125>, paste the generated key into **User key**, and
click **Login**. Use your configured `PANEL_PORT` if it differs from `8125`.
For a remote deployment, replace `localhost` with the server address.

The gateway key from `.env` is not the Panel login key.

## 5. Create more users or keys later

- **Another key for your current account:** open
  <http://localhost:8125/team/api-keys> and click **New Key**.
- **A new user:** sign in as admin, select or create a Team, then open
  **Members → Add Member → Create New User & Add to Team**. Enter the username
  and click **Create & Add**. Copy and save the generated User key immediately;
  the full key is shown only once.

Do not call `init-admin` again to create additional users.

## Troubleshooting

- **401 Unauthorized:** the request is missing a valid gateway Bearer key.
  The command in step 3 reads the running container's key automatically.
- **500 internal_error / Invalid JSON body:** inspect the service logs below.
  If they report `Invalid JSON body`, rerun the complete block in step 3;
  it uses `JSON.stringify` to encode the request correctly.
- **409 already_initialized:** the database already contains users or an
  administrator. Use an existing User key and the Panel to manage users.
  Repeating initialization will not return the original key. Do not delete
  the database volumes to resolve this error.
- **Initialization succeeded but verification failed:** retain the key printed
  before the error, inspect the logs, and try signing in with it. The admin
  already exists; initialization should not be repeated.

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 memory
```

If an earlier setup saved your admin key in
`deploy/global-images/.admin-key`, retrieve it from the repository root with:

```bash
cat deploy/global-images/.admin-key
```
