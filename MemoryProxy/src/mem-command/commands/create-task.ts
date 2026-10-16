/**
 * mem:create-task — 从当前会话上下文生成 Task 并绑定到本 session。
 *
 * 交互（对齐 TAPD 需求"用户确认"闸门）：
 *
 *   ┌ session 未绑真实 task：
 *   │    无参数 → LLM 生成 title+desc → 直接落库+绑定（无需 confirm）
 *   │    有参数 → title = 用户参数(≤40 字)，LLM 只生成 desc → 直接落库+绑定
 *   │            LLM 失败 → 降级：desc 留空，task 照样落库
 *   │
 *   ├ session 已绑真实 task：
 *   │    生成新 draft → 写入 pending-store（TTL 5 分钟）→ 返"预览 + 三选一引导"：
 *   │      1) mem:create-task confirm — 覆盖绑定，新建
 *   │      2) mem:update-task [新描述] — 继续复用当前 Task 只更新描述
 *   │      3) mem:create-task cancel — 撤销
 *   │
 *   ├ `mem:create-task confirm`：
 *   │    从 pending 取出 draft → 创建新 task → 覆盖 session 绑定 → 清 pending
 *   │
 *   └ `mem:create-task cancel`：
 *        清 pending，不落库
 *
 * 参数解析：
 *   - `confirm` / `cancel`（大小写不敏感）单独出现视为子命令
 *   - 其它任意 args 一律作为 lockedTitle（首次调用的 title 提示）
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  createTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;
const TITLE_MAX_LEN = 40;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function truncateTitle(raw: string): string {
  const s = raw.trim();
  return s.length > TITLE_MAX_LEN ? s.slice(0, TITLE_MAX_LEN) : s;
}

/** 判定 args 是否是 confirm / cancel 子命令。仅当整体 trim 后严格等于时命中。 */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeCreateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const recentMessages = ctx.bodyMessages ?? [];
  const rawArgs = (ctx.args ?? "").trim();

  const finalize = (
    messageText: string,
    success: boolean,
    data: Record<string, unknown>,
  ): MemCommandResult => {
    const response = buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    });
    return { success, messageText, data, response };
  };

  const subcommand = parseSubcommand(rawArgs);

  // ── confirm 分支 ────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task operation (it may have expired or been canceled). Run again: \`mem:create-task [title]\`.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task creation failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "create_failed", detail: result.error },
      );
    }

    const prevLine = result.previousTaskId
      ? `\n\n (Previously linked Task unlinked: \`${result.previousTaskId}\`)`
      : "";
    return finalize(
      `✅ New Task created and linked.\n\n` +
        `- **Title**: ${result.title}\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **Description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**:\`${result.taskId}\`${prevLine}`,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
        ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
        ...(result.error ? { bind_warning: result.error } : {}),
      },
    );
  }

  // ── cancel 分支 ─────────────────────────────────────────────────────────
  if (subcommand === "cancel") {
    const result = await cancelPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });
    if (!result.success) {
      return finalize(
        `⚠️ Cancellation failed: ${result.error ?? "unknown"}`,
        false,
        { reason: "cancel_failed", detail: result.error },
      );
    }
    const msg = result.cancelled
      ? `✅ Pending Task operation canceled.`
      : `ℹ️ No pending Task operation.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── 首次调用分支 ────────────────────────────────────────────────────────

  const lockedTitle = rawArgs.length > 0 ? truncateTitle(rawArgs) : undefined;

  if (recentMessages.length === 0) {
    return finalize(
      `⚠️ The request contains no conversation messages. \`mem:create-task\` requires recent conversation context to generate a Task.` +
        `\n\nTip: Have a few conversation turns with the AI before running this command.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await createTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    // 方案 D：taskDraft LLM 跟随主模型 —— 透传客户端当次 model / 上游 / apiKey
    // upstreamProtocol 独立于 ctx.protocol（后者只管响应渲染 SSE 骨架格式,
    // 前者决定 taskDraft 请求打 /messages | /chat/completions | /responses）。
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.upstreamUrl ? { upstreamUrl: ctx.upstreamUrl } : {}),
    ...(ctx.upstreamProtocol ? { protocol: ctx.upstreamProtocol } : {}),
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(lockedTitle ? { lockedTitle, hint: rawArgs } : {}),
  });

  // 落库失败
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = lockedTitle
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. `mem:create-task <your title>` specify a title manually (the LLM generates only the description; an empty description is used if generation fails)";
    return finalize(
      `❌ Task creation failed: ${detail}${hintLine}`,
      false,
      { reason: "create_failed", detail },
    );
  }

  // 已绑分支：pending 预览
  if (result.pending && result.pending.kind === "create") {
    const p = result.pending;
    const currentLine = p.currentTaskTitle
      ? `\`${p.currentTaskId}\`“${p.currentTaskTitle}”`
      : `\`${p.currentTaskId}\``;
    return finalize(
      `⚠️ This session is already linked to Task ${currentLine}.\n\n` +
        `**New Task preview**\n` +
        `- Title: ${p.draftTitle}\n` +
        `- Description: ${trimDesc(p.draftDescription)}\n\n` +
        `Choose the next step:\n` +
        `1. \`mem:create-task confirm\` — Replace the current link and create a new Task\n` +
        `2. \`mem:update-task\` or \`mem:update-task <new description>\` — Reuse the current Task and update only its description (without creating a new one)\n` +
        `3. \`mem:create-task cancel\` — Cancel without making changes`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "create",
          draft_title: p.draftTitle,
          draft_description: p.draftDescription,
          current_task_id: p.currentTaskId,
          ...(p.currentTaskTitle ? { current_task_title: p.currentTaskTitle } : {}),
        },
      },
    );
  }

  // 未绑分支：直接落库成功
  return finalize(
    `✅ Task created and linked to this session.\n\n` +
      `- **Title**: ${result.title}\n` +
      `- **Status**: ${result.status ?? "running"}\n` +
      `- **Description**: ${trimDesc(result.description)}\n` +
      `- **Task ID**:\`${result.taskId}\`\n\n` +
      `Use \`mem:update-task\` to add progress later.`,
    true,
    {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      ...(result.error ? { bind_warning: result.error } : {}),
    },
  );
}
