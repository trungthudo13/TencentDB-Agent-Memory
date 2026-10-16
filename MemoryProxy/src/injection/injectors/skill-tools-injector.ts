/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
  *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * 是否允许主模型创建/修改 skill。默认 false。
   * false 时只注入只读工具（search/list/view/files_read）。
   * 显式设为 true 后注入全部 10 个工具。
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // gateway 需要 `x-tdai-service-id: <spaceId>` 才放行；`x-conversation-id`
  // 让 proxy 复用 session 里的身份 (user_id / team_id / agent_id)。
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  // ── skill_view 用 skill_id(get) 还是 skill_name(get-by-name) ──
  // 默认 id → skill_view 打 /get，body 传 skill_id（配合 available_skills 渲染带 id）。
  // SKILL_VIEW_MODE=name → 回退到 /get-by-name + skill_name（旧行为）。
  // 依据 skill_eval v9(name) vs v10(id) 对比实验：id 模式有调用时 correct% 更高、unknown 减半。
  const skillViewMode = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id";
  const skillViewTool =
    skillViewMode === "id"
      ? [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get`,
          `    body: {"skill_id": "<skill ID, e.g. skl-xxx>", "include_content": true, "include_manifest": true}`,
          `    use:  **Open a skill**: Get the complete SKILL.md and resource tree (manifest). Before reading resource bytes, call this tool, choose a path from the manifest, then use skill_files_read. Obtain skill_id from the \`id=\` field in <available_skills> (e.g. skl-xxxxxx) or the skill_id field in skill_search results.`,
          `  </tool>`,
        ]
      : [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get-by-name`,
          `    body: {"skill_name": "<skill name>", "include_content": true, "include_manifest": true}`,
          `    use:  **Open a skill**: Get the complete SKILL.md and resource tree (manifest). Before reading resource bytes, call this tool, choose a path from the manifest, then use skill_files_read. Use the name in \`- name: description\` from <available_skills>, or the name field in skill_search results.`,
          `  </tool>`,
        ];

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "Keywords describing the skill you need (required, >=1 character)"}`,
    `    use:  Search by keywords + semantics among skills **you can access in the team** (across agents, **excluding** others' private skills, matching the Team Assets tab). query must be nonempty; use 2-5 relevant keywords. Discover additional team skills when yours are insufficient. The server controls result count; try different keywords if needed. Do not add top_k/mode or other body fields (they are ignored).`,
    `  </tool>`,
    "",
    // 暂时下线：<available_skills> 块已经注入 agent 自带的 skill 列表，功能重叠。
    // 后续如果需要分页刷新（skill 太多截断时）再恢复。
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?可选", "name_prefix": "?可选"}, "pagination": {"limit": 50}}`,
    // `    use:  列出 head + active skill；按 owner / 前缀过滤`,
    // `  </tool>`,
    // "",
    ...skillViewTool,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  Read a single resource file. **First call skill_view for the manifest**, then select skill_id + path. Returns a JSON envelope with base64/utf-8 bytes by default.\n    To download locally, append -o <local path> to curl; the proxy returns raw bytes directly to the file, outside context. Run chmod +x on downloaded scripts before execution.`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?optional; briefly explain why this conversation should become a skill (clear reasons help the background extractor identify boundaries)"}`,
    `    use:  Immediately archive this conversation and trigger asynchronous skill extraction by a background agent. The proxy uses session identity and the conversation buffer in core; do not send messages. Trigger when the user has completed a reusable workflow.`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "Complete SKILL.md (including frontmatter)", "resources": "?optional array"}`,
    `    use:  Create a skill; owner is automatically the current agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "New SKILL.md"}`,
    `    use:  Replace SKILL.md (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  Replace a substring in SKILL.md (avoid large diffs)`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  Permanently delete all skill versions`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  Add/update a resource file (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  Delete a resource file (version+1)`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "Error handling: Responses use a `{code, message, request_id, data?}` envelope; `code != 0` indicates a business error. Common errors:"
    : "Note: Only read operations are currently enabled. Contact an administrator to create/modify skills.\nError handling: Responses use a `{code, message, request_id, data?}` envelope; `code != 0` indicates a business error. Common errors:";

  const readErrors = [
    "- 40001 Validation failed: Missing/invalid body fields; see message for the field name.",
    "- 40101 session not initialized:Session not recognized (the tool may have been called in the wrong conversation).",
    "- 40401 SKILL_NOT_FOUND:Skill does not exist or does not belong to your agent; use skill_search for similar skills.",
    "- 50301 upstream unavailable:Core temporarily unavailable; retry later.",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER:You are not the owner and cannot modify this skill.",
    "- 40901 SKILL_VERSION_STALE:Stale version; get the latest version with skill_view before writing.",
    "- 42201 SKILL_NAME_DUPLICATE:Duplicate name in the same team.",
    "- 42202 SKILL_PATCH_NOT_UNIQUE:old_string is not unique; pass replace_all=true.",
  ];

  return [
    "<skill_tools>",
    "The following tools operate on cloud skills. **These are not local tools**; use Bash + curl against the proxy skill-bridge path.",
    "The proxy injects identity and authentication (user_id / team_id / agent_id from the session); include only business fields in the body.",
    "",
    "Invocation template:",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...business fields...}'`,
    `  where <bridge> = ${bridge}`,
    "",
    "Available tools:",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // Stable cache-dedup key — varies by allowLlmWrite + skillViewMode to avoid stale cache
        // (SKILL_VIEW_MODE=id/name 须区分缓存,否则两模式串同一份 session_init 块)
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}:${(process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id"}`,
      },
    }];
  }
}
