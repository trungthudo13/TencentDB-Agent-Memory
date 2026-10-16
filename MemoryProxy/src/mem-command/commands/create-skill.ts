/**
 * mem:create-skill — 手动强制归档当前 session buffer
 *
 * 文案约定：只告知用户"归档已触发 / Skill 提取中"这类概念，不暴露内部
 * task_id、archive_key、文件路径等。想排障时看 `data` 字段或后端日志。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { forceArchiveSkill } from "../../routes/session-force-archive.js";

export async function executeCreateSkill(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const result = await forceArchiveSkill({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    reason: ctx.args || undefined,
  });

  let messageText: string;

  if (!result.success) {
    messageText = `❌ Failed to archive this conversation: ${result.error ?? "Unknown error"}`;
  } else if (result.status === "empty") {
    messageText = `⚠️ No content to archive yet. Continue the conversation and retry`;
  } else {
    messageText = `✅ Conversation archived successfully. Skill extraction is in progress`;
  }

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // task_id / archive_key 仍保留在结构化数据里 —— 面板 / 日志 / e2e 可读，
    // 只是不再拼进用户可见文案。
    data: result.success
      ? { status: result.status, task_id: result.taskId, archive_key: result.archiveKey }
      : undefined,
    response,
  };
}
