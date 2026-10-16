/**
 * WorkBuddy Session Init Form — `AskUserQuestion` tool_call.
 *
 * WorkBuddy 客户端复用 CC 的 `AskUserQuestion` tool（抓包 [wb-ask-user-schema]
 * 已实证），但底层协议是 **OpenAI /v1/chat/completions**（非 Anthropic）。
 *
 * 因此本 form：
 *   - questions[] shape 与 CC 完全一致（{question, header, options:[{label,description}], multiSelect}）
 *   - 传输侧走 OpenAI chat/completions SSE `tool_calls` chunk 流（CB 那套骨架）
 *   - Tool name: `AskUserQuestion`（同 CC）
 *   - ID prefix: `call_wb_session_init_`（区分 CB 的 `call_session_init_`）
 *   - 分页: 每页 3 option + 1 个"更多→"槽位（对齐 CC，避免超过硬上限）
 *
 * 不含任何 CodeBuddy XML 逻辑；也不共用 CB 的 form builder（CB 用
 * `ask_followup_question` XML 语义，WB 用 CC 的 AskUserQuestion 语义）。
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "call_wb_session_init_";

export const TEAM_FORM_TITLE = "Session initialization — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session initialization — Select Agent and Task";
export const RETRY_FORM_TITLE = "Selection not recognized. Please select again";

export const SKIP_LABEL = "Skip linking (continue without injection)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, skip linking";
export const ASSET_CONFIRM_FORM_TITLE = "Session initialization — Link team assets";

/**
 * 附在每步 question 文末的通用备注。
 * AskUserQuestion 会给用户一个 "Other" 输入框，回复"跳过 / skip / 不关联" 就
 * 走 SKIP_RE bypass；文案与 claude-code/codex/codebuddy/dsh 五端统一。
 */
const SKIP_HINT = '(Select the closest option; custom input is currently unsupported. Skipping disables team asset injection for this session.)';

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any WB form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a WB session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** 分页：当前页码 (0-based)；对齐 CC 只使用一个 pageIndex（team/agent/task 单题） */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── AskUserQuestion input schema (与 CC 完全一致) ──────────────────────────────

interface WBAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: WBAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: WBAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Link team assets to this conversation?" + SKIP_HINT,
      header: "Link assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Select Team / Agent / Task to inject team context" },
        { label: ASSET_CONFIRM_NO, description: "Continue without injecting any content" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // 分页对齐 agent/task —— 老实现 `slice(0, 4)` 硬截断，用户 team 数 ≥5 时
    // 后续 team 静默消失且没有翻页入口。2026-09-03 修复。
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(teams.length, pageIndex);
    const slice = teams.slice(page.start, page.end);
    const teamOpts: Array<{ label: string; description: string }> = slice.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      teamOpts.push({ label: MORE_LABEL, description: `View next batch (${remaining} Teams remaining)` });
    }

    if (teamOpts.length < 2) {
      throw new Error(
        `[wb form] team page ${pageIndex} has ${teamOpts.length} option(s); ` +
          `team stage requires ≥2 teams — caller must auto-select when teams.length === 1, ` +
          `and pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? `(page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select the Team for this session${pageSuffix}:` + SKIP_HINT,
      header: page.totalPages > 1 ? `Team ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `View next batch (${remaining} Agents remaining)` });
    }

    if (combinedOptions.length < 2) {
      throw new Error(
        `[wb form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? `(page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select an Agent in ${team.team_name}${pageSuffix}:` + SKIP_HINT,
      header: page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    const taskOpts: Array<{ label: string; description: string }> = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `View next batch (${remaining} Tasks remaining)`,
      });
    }

    if (taskOpts.length < 2) {
      throw new Error(
        `[wb form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? `(page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Select a Task to link in ${team.team_name}${taskPageSuffix}:` + SKIP_HINT,
      header: page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a WorkBuddy `AskUserQuestion` fake form response.
 *
 * 传输：**OpenAI chat/completions**（stream 或 non-stream）。
 * questions shape：同 CC AskUserQuestion —— `{questions: [{question, header, options, multiSelect}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "wb-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: argsStr,
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 2: arguments delta (whole JSON as single delta)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
