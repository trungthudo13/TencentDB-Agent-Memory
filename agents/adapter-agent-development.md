# New client adaptation development guide

> **Purpose**: To connect a new AI agent client that Memory Proxy **does not yet support** (Aider / Cursor / a new desktop IDE / a custom CLI / a future harness), follow this guide from "traffic reconnaissance → adaptation scope → 20 implementation steps → passing e2e". It consolidates integration points and common pitfalls validated across five clients (Claude Code / CodeBuddy / Codex / Workbuddy / dsh), so the next integration can avoid repeating them.
>
> **Do not skip steps**: each step comes from an actual issue. When you encounter a problem, first consult [§3 Common pitfalls](#phase-3-common-pitfalls).
>
> **Reference implementation**: dsh is the most comprehensive integration case for encountered pitfalls, with all code in this repository. See [Reference implementation: dsh (grouped by capability)](#reference-implementation-dsh-grouped-by-capability) at the end, which lists **each adaptation capability and its code changes** for reuse with your client.

---

## Phase 0: Traffic reconnaissance (30–60 minutes, no code changes)

**Why capture traffic first**: assuming clients behave identically repeatedly causes problems. **Each** of the five clients differs in body shape / session_id header / metadata wrapper / option limits / ask-user tool name. **Identify these five differences** before editing code.

### 0.1 Capture 3–5 real requests

Use **mitmproxy**:

```bash
pip3 install --user mitmproxy    # Skip if already installed
mitmdump -p 8888 -s /tmp/capture.py --set stream_large_bodies=100m
```

The addon in `/tmp/capture.py` does one thing: filter target client requests by `user-agent` and save request/response bodies as separate JSON files. Replace the filter keyword with the new client's fingerprint.

**Critical**: Node ≥18 clients need `NODE_OPTIONS='--use-env-proxy'` to recognize `HTTPS_PROXY` (undici does not recognize it by default). See [§3 Pitfall G](#pitfall-g-node-22-https_proxy-does-not-work-for-traffic-capture).

### 0.2 Fill in the five differences after capturing traffic

Create a `<client>-recon/` directory (outside this repository or locally) for fixtures and analysis. Compare each item below:

| Dimension | What to inspect in captures |
|---|---|
| **body shape** | Is the primary field `messages[]` (OpenAI/Anthropic) or `input[]` (OpenAI Responses)? Is user text at `messages[i].content[j].text`, `messages[i].content` (string), or `input[i].content[j].text`? |
| **session_id header** | Which headers exist, and which is the sid? Is there a fallback field in the body? |
| **Initial request metadata with role=user** | Count role=user entries inserted into `messages[]` and identify stable signatures for each (prefixes such as `<system-reminder>` / runtime context / available_skills). Only actual user input should be treated as a user message by the proxy; filter other metadata entries. |
| **ask-user tool name + shape** | Find client source such as `packages/*/tool-ask-user/**` and obtain the tool name + parameter schema (required fields / snake vs camel case). |
| **Option count limit** | Search client UI source for `options.length` / `maxOptions` / `slice`; no truncation means pagination is unnecessary. |

**These five differences determine the subsequent code changes**. Missing any one causes problems.

### 0.3 Determine whether auxiliary requests need to bypass the pipeline

Check whether the client sends **distinct request types** (compaction / title-gen / memgen, etc.). Criteria:

- Separate endpoint path? (Codex has `/responses/compact`; WorkBuddy is similar)
- Separate header? (dsh has `x-deepseek-harness-compact:1`)
- Body characteristics? (dsh title-gen uses missing tools + `thinking.disabled` + `max_tokens ≤ 128` + a system prompt prefix)

**For any client with auxiliary requests, adapter `classifyRequest` must recognize them**. CC/CB requests are all main with no auxiliary requests; Codex/WorkBuddy/dsh have auxiliary requests.

---

## Phase 1: Adaptation scope overview (define the work first)

Memory Proxy performs **at least** the following ten functions for a client. Before comparing dsh changes or copying code, **review the table**: which capabilities are **required**, **optional**, or **not applicable** to the new client? Complete the checklist before implementation in Phase 2 to understand the workload.

| # | Capability | Problem addressed | Required? | Related modules |
|---|---|---|---|---|
| 1 | **Routing & allowlists** | Recognize `/<client>/<spaceId>/...` and add `<client>` to regex allowlists; otherwise auth returns 401 or requests fall through to 404 | ✅ Required | `MemoryProxy/src/server.ts`, `MemoryProxy/src/credit-reporter.ts` |
| 2 | **Session ID resolution** | Find a stable unique conversation ID in headers/body so requests in one conversation share sessionKey; otherwise all conversations collide on one key and session-init state becomes inconsistent | ✅ Required | `MemoryProxy/src/session/session-key.ts::resolveConversationId` |
| 3 | **Request classification (main / aux / headless)** | Distinguish actual user conversations from background auxiliary requests (title-gen / compaction / memgen); auxiliary requests must **skip all** session-init / mem / injection / L0 / skill triggers and pass through directly | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::classifyRequest`, start of `MemoryProxy/src/handler.ts` |
| 4 | **User text extraction** | Extract actual user input from the body for mem commands / L0 archiving / skill extraction, skipping role=user metadata | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::extractUserText`, `MemoryProxy/src/session/store.ts::tryHistoryScan`, `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` |
| 5 | **Session Init Form** | Present a four step form on the first conversation for team / agent / task selection (`asset_confirm → team → agent → task`), using the client preset's `ask_user_question` or equivalent tool_call | ⚠️ Required for interactive clients; optional for pure CLI headless clients (use Pitfall C bypass) | `MemoryProxy/src/session/<client>/form.ts`, `MemoryProxy/src/session/index.ts` dispatch, `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate |
| 6 | **Header preselection (skip form)** | CI/CD / automation / clients unable to respond to forms can register in one step using `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id`; shared support already exists, so most clients **need no code changes** | ➖ Optional (already shared) | No changes needed; handled by `MemoryProxy/src/session/registrar.ts` |
| 7 | **Asset injection** | Insert asset blocks such as `<agent_skills>` / `<user_memory>` / `<session_context>` / `<tdai_profile_memory>` into the system message on each main turn to deliver team memory to the LLM | ✅ Required | Use existing `MemoryProxy/src/injection/adapters/{openai,anthropic}.ts`; preserve special wire fields (such as dsh `reasoning_content`) through metadata round trips |
| 8 | **Wire compatibility / special field passthrough** | Clients may strictly require nonstandard fields on round trips (dsh `reasoning_content` / DeepSeek thinking chain); injection parse→serialize must preserve them | ⚠️ Required only when the client has special fields | Store in `ContextMessage.metadata` during `parseMessage` / `serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts` |
| 9 | **Mem command interception** | Intercept `mem:help` / `mem:sync` / `mem:create-skill` / `mem:session-reset` and return local responses (open panel / refresh assets / trigger extraction / reset state) without calling the upstream LLM | ✅ Fully available to clients supporting forms; partially available to headless bypass clients | Mem command section of `MemoryProxy/src/handler.ts` (shared; automatically active when `agentSource` is recognized) |
| 10 | **L0 archiving / skill extraction** | Record main conversation messages in both directions through `tdai-recorder:write-l0`; threshold or force-archive triggers `skill/conversation/add` for core skill extraction | ✅ Required | End of `MemoryProxy/src/handler.ts` (shared; automatically active with correct aux/headless classification) |
| 11 | **Observability / Langfuse** | Add `agent_source:<client>` trace tags, session-init stage logs, and tool_call instrumentation for production troubleshooting | ✅ Required (one tag line, almost no cost) | Shared injection of `agentAdapter.agentKind`; confirm the new `agent_source` appears in Langfuse trace tags |

**Decision rules**:

- **Complete every required capability** before considering the integration basically usable
- Choose optional capabilities based on client scenarios (CLI only clients can skip 5 and 9, keeping 6 header preselection)
- Unique wire fields (such as DeepSeek chain of thought) → capability 8 is mandatory, otherwise upstream returns 400
- Auxiliary title-gen / compact requests → capability 3 is mandatory, otherwise auxiliary requests incorrectly show forms / write L0

**Effort estimate**: a complete integration (capabilities 1–11), with the validated dsh reference, takes about 3–4 working days for capture + coding + unit tests + e2e; unfamiliar pitfalls require additional time.

---

## Phase 2: Code changes (20 step checklist, in order)

Map the capabilities selected in Phase 1 to concrete files. Each step lists its corresponding capability numbers (#1 = "Routing & allowlists", etc.).

### 2.1 Four skeleton steps (30 minutes) — capabilities #1, #3, #4

| # | File | Change | Capability |
|---|---|---|---|
| 1 | `MemoryProxy/src/agent-adapters/<client>.ts` | Create: three signal `classifyRequest` + `extractUserText` | #3 #4 |
| 2 | `MemoryProxy/src/agent-adapters/types.ts` | Add `"<client>"` to the `AgentKind` union | #3 |
| 3 | `MemoryProxy/src/agent-adapters/index.ts` | Add a factory switch case | #3 |
| 4 | `MemoryProxy/src/server.ts` | Add nine routes (with/without `v1` × main endpoint/aux/cost-guard/analyse marker), using the dsh section as reference | #1 |

### 2.2 Three allowlist & session identification steps — capabilities #1, #2, #7

| # | File | Change | Capability |
|---|---|---|---|
| 5 | `MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Add `|<client>` to the regex; **omission causes auth 401 `missing service_id`** | #1 |
| 6 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` | Add the client's session header to the header fallback chain | #2 |
| 7 | Skip if no dedicated profile is needed; otherwise create `MemoryProxy/src/injection/agents/<client>/*` (see `MemoryProxy/src/injection/agents/workbuddy/`) | #7 |

### 2.3 Four Session Init Form integration steps — capability #5

| # | File | Change | Capability |
|---|---|---|---|
| 8 | `MemoryProxy/src/session/<client>/form.ts` | Create: tool name / parameter shape must exactly match the client preset; do not reuse another client's schema | #5 |
| 9 | `MemoryProxy/src/session/index.ts` | Add dispatch branch (see WorkBuddy: render again outside the CB state machine after it generates `formData`) | #5 |
| 10 | `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate | Add `|| agentSource === "<client>"` to five gates; omission combines agent+task selection and bypasses directly | #5 |
| 11 | `MemoryProxy/src/session/codebuddy/cleaner.ts` `tool_call_id` regex | Add recognition of the `|<client>_` prefix | #5 |

### 2.4 Three metadata filtering & wire compatibility steps — capabilities #4, #8

| # | File | Change | Capability |
|---|---|---|---|
| 12 | `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` | Exclude initial metadata from the user count based on client signatures; omission falsely detects history and skips session-init | #4 |
| 13 | `MemoryProxy/src/session/store.ts::tryHistoryScan` | Apply the same filtering logic | #4 |
| 14 | Preserve special wire fields on round trips (such as dsh `reasoning_content`) through metadata in parse/serialize in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`; validate by comparing inbound/outbound body dumps using debug environment variables | #8 |

### 2.5 Two handler bypass steps — capabilities #3, #5, #9, #10

| # | File | Change | Capability |
|---|---|---|---|
| 15 | Start of `MemoryProxy/src/handler.ts` | Classify with `agentAdapter.classifyRequest(body, path, headers)`; when `isAuxiliary=true`, **skip all** session-init / mem / injection / L0 / skill triggers and pass through directly | #3 #9 #10 |
| 16 | Start of `MemoryProxy/src/handler.ts` | For CLI headless scenarios (fewer preset tools, no ask-user), add a dsh style `_headless` check and skip forms like auxiliary requests; show a mem command hint or fall back to header preselection | #5 #9 |

### 2.6 Four testing & validation steps — capabilities #5, #9, #10, #11

| # | Content | Capability |
|---|---|---|
| 17 | Unit tests: adapter `classifyRequest` + form builder shape + captured fixture end to end; put in `MemoryProxy/src/__tests__/agent-adapters/<client>.test.ts` + `MemoryProxy/src/session/<client>/__tests__/form.test.ts` | #3 #5 |
| 18 | curl smoke check: call `/<client>/default/*` to trigger the form and verify session-init's three state transitions (`asset_confirm → team → agent → task`) | #5 |
| 19 | Web e2e (Playwright recommended): **actually run the client web UI**, including four session-init steps + one real conversation turn, checking injection + archiving + Langfuse trace | #5 #7 #10 #11 |
| 20 | Mem / L0 / skill end to end: send `mem:help` / `mem:sync` / `mem:create-skill` in an initialized session, trigger skill extraction with a long conversation, and search proxy logs to verify L0 writes | #9 #10 |

---

## Phase 3: Common pitfalls

Each of the first five clients encountered at least three pitfalls. **Consult this section before debugging independently**.

### Pitfall A: `missing service_id (spaceId not in request path)` 401

**Root cause**: the allowlist regex in `credit-reporter.ts::extractSpaceIdFromPath` omits the new client name.

**Fix**: add it to `^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|<new-client>)$`.

### Pitfall B: Session-init form appears incorrectly or never appears

- **Never appears** = `resolveConversationId` fallback does not recognize the client session header → sessionKey falls back to keyId; or `isFreshCBConversation` treats initial metadata user entries as history → markerless bypass.
  - Fix the `session-key.ts` fallback chain and add metadata signature filtering to `codebuddy/init.ts::isFreshCBConversation` + `store.ts::tryHistoryScan`
- **Appears, but no task form after agent selection** = the new client is missing from split-stage gates → legacy CB pending_agent_task combines selection → empty task causes direct bypass.
  - Add `|| agentSource === "<client>"` to five gates in `codebuddy/init.ts`
- **Infinite pagination / default task appears at the start of every page** = CC's four options per page pagination was reused without MORE interception.
  - Fix: if the client UI has no option limit, **disable pagination and render all options** (as dsh does)

### Pitfall C: Upstream 400 `unknown tool ""`

**Root cause**: the client preset lacks `ask_user_question` (or the client's UI tool), so validation rejects the proxy's synthetic `tool_call`.

**Fix**: add headless bypass; if `body.tools` is nonempty but lacks that tool, pass through without showing a form.

### Pitfall D: Upstream 400 `The reasoning_content in the thinking mode must be passed back to the API`

**Root causes** (two issues together):

1. Synthetic session-init assistant messages omit `reasoning_content`
2. An empty string `""` is inserted → the client's translate.ts removes it using a `length > 0` check

**Fix**: insert a **nonempty** placeholder in the synthetic response (such as `[proxy session-init form]`).

**Secondary pitfall**: the placeholder is nonempty and the client replays it to the proxy, but **injection parse→serialize removes the field**.

- Use `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` to capture and compare inbound/outbound bodies.
- Fix `parseMessage`/`serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` / `anthropic.ts`, storing passthrough fields in `ContextMessage.metadata`.

### Pitfall E: Auxiliary requests (compaction / title) incorrectly trigger session-init forms

**Root cause**: `classifyRequest` is missing at the start of `handler.ts`, so all requests are treated as main.

**Fix**: call `agentAdapter.classifyRequest(body, path, headers)` at the start of `handler.ts`; when `isAuxiliary=true`, **skip all** session-init / mem / injection / L0 / skill triggers.

### Pitfall F: Client specific wire fields (such as `reasoning_content`) lost on round trips

See the secondary issue in Pitfall D. **General approach**: compare inbound/outbound fields using `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY`; update the adapter for any missing field.

### Pitfall G: Node 22 HTTPS_PROXY does not work for traffic capture

**Fix**: add `NODE_OPTIONS='--use-env-proxy'`. Experimental in undici, but currently the only approach.

### Pitfall H: Headless captures lead to assuming a tool does not exist

**Lesson**: the preset system determines tools; different profiles commonly expose different tools. **Web / TUI tools arrays are always more complete than headless ones**. Prefer web captures or capture both modes.

---

## Completion criteria

Integration is complete only after **all** of the following are verified (corresponding capability numbers are on the left):

| Capability | Completion criterion |
|---|---|
| #1 Routing | `curl -X POST /<client>/default/chat/completions` returns neither 404 nor 401 `missing service_id` |
| #2 sessionKey | Multiple requests with the same session_id show identical `sessionKey=` values in proxy logs |
| #3 Classification | Auxiliary requests (compaction / title-gen) show `[request-classify] → auxiliary (skip ...)` in proxy logs and pass through directly |
| #5 Session Init | First response returns a form (role=assistant + `tool_call` uses the client preset's ask-user tool name); Playwright completes `asset_confirm → team → agent → task` |
| #7 Injection | Main conversation upstream returns 200, and its system message includes asset blocks such as `<agent_skills>` / `<user_memory>` |
| #8 Wire compatibility | Main conversation upstream **does not return** 400 (`reasoning_content` / `unknown tool` / `invalid_request_error`) |
| #9 Mem commands | `mem:help` / `mem:sync` / `mem:create-skill` are intercepted and return local responses |
| #10 L0 & skill | `tdai-recorder:write-l0` in proxy logs confirms L0 persistence; `[skill-conversation-add] archived reason=tool_calls` confirms skill extraction triggered |
| #11 Observability | Langfuse trace includes `agent_source:<client>` tag |
| — Unit tests | `npx vitest run src/session/<client> src/__tests__/agent-adapters/<client>.test.ts` passes fully |
| — Full test suite | `npx vitest run` has no regressions |

---

## Reference implementation: dsh (grouped by capability)

dsh is the integration case with **the most encountered pitfalls and the broadest coverage**. Using capability numbers from [Phase 1 adaptation scope](#phase-1-adaptation-scope-overview-define-the-work-first), the table lists **code locations for each dsh capability**. Reuse them and rename for your client.

| Capability | dsh implementation location | Description |
|---|---|---|
| #1 Routing & allowlists | dsh section in `MemoryProxy/src/server.ts` (nine routes)<br>`MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Main `/chat/completions` × (with/without v1) × (main/aux/cost-guard/analyse marker) combinations |
| #2 Session ID resolution | `MemoryProxy/src/session/session-key.ts::resolveConversationId` (`x-deepseek-harness-session-id` fallback) | dsh obtains sid only from headers, without body fallback |
| #3 Classification | `MemoryProxy/src/agent-adapters/dsh.ts::classifyRequest`<br>Auxiliary bypass at the start of `MemoryProxy/src/handler.ts` | Three signals: compact header > title body shape > main |
| #4 User text & metadata filtering | `MemoryProxy/src/agent-adapters/dsh.ts::extractUserText`<br>`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation`<br>`MemoryProxy/src/session/store.ts::tryHistoryScan` | dsh inserts three role=user metadata entries in the initial request; skip by signature matching |
| #5 Session Init Form | `MemoryProxy/src/session/dsh/form.ts` (tool = `ask_user_question`, call_id prefix `call_dsh_session_init_`)<br>dsh dispatch branch in `MemoryProxy/src/session/index.ts`<br>Add `agentSource === "dsh"` to five split-stage gates in `MemoryProxy/src/session/codebuddy/init.ts`<br>Add `dsh_` prefix to `tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` | Reuses CB state machine; dsh UI has no option limit, so **no pagination** |
| #7 Injection | Reuses `MemoryProxy/src/injection/adapters/openai.ts` (no dedicated profile) | dsh uses standard OpenAI Chat and CB injection templates |
| #8 Wire compatibility | `MemoryProxy/src/injection/adapters/openai.ts::parseMessage`/`serializeMessage` (preserve `reasoning_content` through `ContextMessage.metadata`) | DeepSeek thinking chain strictly requires the field on round trips |
| #9 Mem commands | Shared mem command section applies automatically; reduced functionality only in dsh headless mode (`handler.ts::_dshHeadless` check) | Headless bypass clients receive a specific fallback message for `mem:session-reset` |
| #10 L0 & Skill | Shared handler end applies automatically; skipped with `_dshHeadless` (relevant `if !_dshHeadless` in `handler.ts`) | No dsh specific handling needed after correct auxiliary classification |
| #11 Observability | `agentAdapter.agentKind = "dsh"` is injected into Langfuse trace tags by shared logic | No additional instrumentation code needed |
| — Headless Bypass (dsh specific capability) | `MemoryProxy/src/handler.ts::_dshHeadless` (nonempty `body.tools` without `ask_user_question` → bypass) | dsh CLI has no preset; skip form / mem / injection throughout the pipeline |
| — Unit tests (39, most comprehensive fixture set) | `MemoryProxy/src/__tests__/agent-adapters/dsh.test.ts` (19 adapter tests)<br>`MemoryProxy/src/session/dsh/__tests__/form.test.ts` (17 form tests)<br>`MemoryProxy/src/injection/adapters/__tests__/openai.test.ts` (three OpenAI round trip tests) | Mostly reusable after changing the client name |

For user facing configuration documentation (baseURL / configuration files / session-init interaction), see [`agents/dsh/README.md`](./dsh/README.md).
