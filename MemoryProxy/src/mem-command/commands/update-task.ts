/**
 * mem:update-task — 更新已绑定 Task。
 *
 * 交互（每次都需要用户确认）：
 *
 *   ┌ session 未绑 → 拦截，引导 mem:create-task
 *   ├ 首次调用（无 confirm/cancel 子命令）：
 *   │    有参数 → description 直接替换（跳 LLM）→ 写 pending → 预览
 *   │    无参数 → LLM diff 生成新 desc + status 建议 → 写 pending → 预览
 *   │            LLM 判 changed=false → 返"无需更新"，不写 pending
 *   ├ `mem:update-task confirm` → 从 pending 取 → updateTask（含 status 透传） → 清 pending
 *   └ `mem:update-task cancel`  → 清 pending
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  updateTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeUpdateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
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

  // ── confirm ─────────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task update (it may have expired or been canceled). Run again: \`mem:update-task [details]\`.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task update failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "update_failed", detail: result.error },
      );
    }

    return finalize(
      `✅ Task updated.\n\n` +
        `- **Title**: ${result.title}(immutable)\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **New description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**:\`${result.taskId}\``,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
      },
    );
  }

  // ── cancel ──────────────────────────────────────────────────────────────
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
      ? `✅ Pending Task update canceled.`
      : `ℹ️ No pending Task update.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── 首次调用 ────────────────────────────────────────────────────────────

  const directDescription = rawArgs.length > 0 ? rawArgs : undefined;

  if (!directDescription && recentMessages.length === 0) {
    return finalize(
      `⚠️ The request contains no conversation messages. \`mem:update-task\` without arguments requires recent conversation context.` +
        `\n\nYou can use: \`mem:update-task <your additional description>\` to specify the new description manually.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await updateTaskFromSession({
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
    ...(directDescription ? { directDescription, hint: rawArgs } : {}),
  });

  // 未绑
  if (!result.success && result.error?.includes("no task bound")) {
    return finalize(
      `⚠️ No Task is linked to this session. Run \`mem:create-task\` to create one before updating it.`,
      false,
      { reason: "no_task_bound" },
    );
  }

  // 跨用户更新：kernel 不支持，proxy 侧提前拒绝并建议新建
  if (!result.success && result.error === "not_creator") {
    return finalize(
      `❌ Cannot update: You did not create this Task. Cross-user modification is not supported.\n\n` +
        `Use \`mem:create-task\` to create your own Task based on this conversation.`,
      false,
      { reason: "not_creator" },
    );
  }

  // 其它错误
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = directDescription
      ? ""
      : "\n\nYou can:\n1. Retry later\n2. `mem:update-task <your additional details>` specify the new description manually";
    return finalize(
      `❌ Task update failed: ${detail}${hintLine}`,
      false,
      { reason: "update_failed", detail },
    );
  }

  // LLM 判无需更新
  if (result.noUpdateNeeded) {
    return finalize(
      `ℹ️ No Task update needed: recent conversation adds no progress or scope changes.\n\n` +
        `Task ID: \`${result.taskId}\`\n` +
        `Run \`mem:update-task [details]\` again later to reassess, or provide arguments to force an update.`,
      true,
      { reason: "no_update_needed", task_id: result.taskId },
    );
  }

  // 首次调用：pending 预览
  if (result.pending && result.pending.kind === "update") {
    const p = result.pending;
    const statusLine = p.statusSuggestion
      ? `\n- Suggested status: ${p.statusSuggestion}`
      : "";
    return finalize(
      `📝 Task ${p.currentTitle ?? p.taskId} update preview:\n\n` +
        `- New description: ${trimDesc(p.draftDescription)}${statusLine}\n\n` +
        `Reply with \`mem:update-task confirm\` to confirm or \`mem:update-task cancel\` to cancel.`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "update",
          task_id: p.taskId,
          draft_description: p.draftDescription,
          ...(p.statusSuggestion ? { status_suggestion: p.statusSuggestion } : {}),
          ...(p.currentTitle ? { current_title: p.currentTitle } : {}),
          ...(p.currentStatus ? { current_status: p.currentStatus } : {}),
        },
      },
    );
  }

  // 兜底（理论走不到）：返回当前状态
  return finalize(
    `ℹ️ No Task changes.\n\nTask ID: \`${result.taskId}\``,
    true,
    { task_id: result.taskId },
  );
}
