/**
 * HTTP client — forwards MCP tool calls to the Hono knowledge API.
 *
 * Each MCP tool maps to a POST endpoint on the knowledge service.
 * The client sends the tool arguments as JSON body and returns the
 * ApiResponseEnvelope data field (or error).
 */

import { createLogger } from "../logger.js";

const log = createLogger("mcp-http");

export interface HttpClientOptions {
  baseUrl: string;
  /** Optional bearer token for auth. */
  token?: string;
  serviceId?: string;
  /** API mount path; defaults to /v3 for existing stdio clients. */
  apiPrefix?: string;
  /** In-process HTTP adapter for the embedded MCP endpoint. */
  fetch?: (request: Request) => Response | Promise<Response>;
}

export interface ApiResponse {
  code: number;
  message: string;
  data: unknown;
}

/**
 * Call a knowledge API endpoint.
 * @param endpoint Path without /v3 prefix (e.g. "/wiki/search", "/code-graph/search")
 * @param body Request body
 * @returns The ApiResponseEnvelope data field on success, or throws on error.
 */
export async function callApi(
  opts: HttpClientOptions,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const prefix = (opts.apiPrefix ?? "/v3").replace(/\/$/, "");
  const url = `${opts.baseUrl.replace(/\/$/, "")}${prefix}${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["x-tdai-service-id"] = opts.serviceId || "default";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  log.debug(`POST ${url}`);

  let resp: Response;
  try {
    const request = new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    resp = await (opts.fetch ? opts.fetch(request) : fetch(request));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fetch failed for ${endpoint}: ${msg}`);
    throw err;
  }

  let json: ApiResponse;
  try {
    json = (await resp.json()) as ApiResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`JSON parse failed for ${endpoint} (status=${resp.status}): ${msg}`);
    throw new Error(`API error: ${resp.status} (invalid JSON)`);
  }

  // CodeGraph deliberately returns HTTP 500 with an MCP-style tool failure.
  // Keep its actionable details instead of replacing them with envelope "ok".
  if (isApiToolResult(json.data) && json.data.isError) return json.data;

  if (resp.status >= 400 || json.code !== 0) {
    log.warn(`API error on ${endpoint}: status=${resp.status} code=${json.code} message="${json.message}"`);
    throw new Error(json.message || `API error: ${resp.status}`);
  }

  return json.data;
}

export function isApiToolResult(value: unknown): value is { text: string; isError: boolean } {
  return value !== null && typeof value === "object" &&
    "text" in value && typeof value.text === "string" &&
    "isError" in value && typeof value.isError === "boolean";
}
