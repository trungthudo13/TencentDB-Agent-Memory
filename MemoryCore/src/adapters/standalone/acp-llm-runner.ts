import type { LLMRunner, LLMRunParams } from "../../core/types.js";

/** Text-only L1 transport. Kept separate from the tool-enabled L2/L3 runner. */
export class AcpLLMRunner implements LLMRunner {
  private readonly config: { baseUrl: string; token: string; model: string; timeoutMs: number };
  constructor(config: { baseUrl: string; token: string; model: string; timeoutMs: number }) {
    this.config = config;
  }

  async run(params: LLMRunParams): Promise<string> {
    if (params.enableTools || (params.tools && Object.keys(params.tools).length)) {
      throw new Error("MemoryAcp L1 runner does not support tools");
    }
    const timeout = AbortSignal.timeout(params.timeoutMs ?? this.config.timeoutMs);
    const signal = params.abortSignal ? AbortSignal.any([timeout, params.abortSignal]) : timeout;
    const messages: Array<{ role: string; content: string }> = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.prompt });
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.token}`,
      },
      // ACP controls generation limits. Do not send unsupported OpenAI sampling,
      // max_tokens or tools fields. L1's existing parser validates model output.
      body: JSON.stringify({ model: this.config.model, messages, stream: false }),
      signal,
    });
    if (!response.ok) {
      // Do not expose upstream bodies (which may include prompts or credentials).
      await response.body?.cancel();
      throw new Error(`MemoryAcp L1 request failed (HTTP ${response.status})`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
    };
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string" || !choice.message.content.trim()) {
      throw new Error("MemoryAcp returned an incomplete or invalid L1 answer");
    }
    return choice.message.content;
  }
}

/** Deployment-level opt-in, restricted to L1 call sites. Empty URL disables it. */
export function createAcpL1Runner(env: NodeJS.ProcessEnv = process.env): AcpLLMRunner | undefined {
  const baseUrl = env.TDAI_L1_ACP_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid TDAI_L1_ACP_BASE_URL");
  }
  const token = env.TDAI_L1_ACP_TOKEN;
  if (!token) throw new Error("TDAI_L1_ACP_TOKEN is required when L1 ACP is enabled");
  const timeoutMs = Number(env.TDAI_L1_ACP_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid TDAI_L1_ACP_TIMEOUT_MS");
  return new AcpLLMRunner({ baseUrl, token, timeoutMs, model: env.TDAI_L1_ACP_MODEL?.trim() || "codex" });
}
