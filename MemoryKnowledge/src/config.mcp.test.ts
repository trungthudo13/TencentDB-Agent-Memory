import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("MCP deployment configuration", () => {
  it("enables HTTP MCP while rejecting browser origins by default", () => {
    vi.stubEnv("KNOWLEDGE_MCP_ENABLED", "");
    vi.stubEnv("KNOWLEDGE_MCP_ALLOWED_ORIGINS", "");
    expect(loadConfig().mcp).toEqual({ enabled: true, allowedOrigins: [] });
  });

  it("allows disabling MCP and configuring explicit origins", () => {
    vi.stubEnv("KNOWLEDGE_MCP_ENABLED", "false");
    vi.stubEnv("KNOWLEDGE_MCP_ALLOWED_ORIGINS", " https://agent.example, http://localhost:3000,https://agent.example ");
    expect(loadConfig().mcp).toEqual({
      enabled: false,
      allowedOrigins: ["https://agent.example", "http://localhost:3000"],
    });
  });

  it.each(["*", "null", "https://*.example", "https://agent.example/path", "https://user:secret@agent.example", "file://host", "not-a-url"])(
    "rejects an unsafe or malformed origin: %s", (origin) => {
      vi.stubEnv("KNOWLEDGE_MCP_ALLOWED_ORIGINS", origin);
      expect(() => loadConfig()).toThrow("KNOWLEDGE_MCP_ALLOWED_ORIGINS");
    },
  );
});
