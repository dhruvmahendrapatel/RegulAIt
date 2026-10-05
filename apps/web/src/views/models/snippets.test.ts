/**
 * ADR-0172 — the "Try it" samples: right endpoints, the binding pinned by
 * header, the request text escaped for each language, and never a real key.
 */
import { describe, expect, it } from "vitest";
import { buildSnippets, SNIPPET_TABS } from "./snippets";

const base = { base: "https://gw.example.test/", agentId: "11111111-2222-4333-8444-555555555555", model: "claude-opus-5", name: "claude-opus" };

describe("buildSnippets", () => {
  const out = buildSnippets({ ...base, prompt: "Say hi" });

  it("has one sample per tab", () => {
    expect(Object.keys(out).sort()).toEqual(SNIPPET_TABS.map((t) => t.id).sort());
  });

  it("targets the compatible endpoints on the console's own origin (no double slash)", () => {
    expect(out.curl).toContain("curl https://gw.example.test/v1/chat/completions");
    expect(out.curl).toContain("curl https://gw.example.test/v1/messages");
    expect(out.typescript).toContain('baseURL: "https://gw.example.test/v1"');
    expect(out.python).toContain('base_url="https://gw.example.test/v1"');
    // the Anthropic SDK appends /v1/messages itself, so it gets the bare origin
    expect(out.anthropic).toContain('baseURL: "https://gw.example.test"');
    for (const s of Object.values(out)) expect(s).not.toContain("test//v1");
  });

  it("sends the model id and pins the binding with x-regulait-agent-id in every sample", () => {
    for (const s of Object.values(out)) {
      expect(s).toContain("claude-opus-5");
      expect(s).toContain("x-regulait-agent-id");
      expect(s).toContain(base.agentId);
    }
  });

  it("falls back to the binding name when there is no model id", () => {
    const r = buildSnippets({ ...base, model: null, prompt: "x" });
    expect(r.typescript).toContain('model: "claude-opus"');
  });

  it("reads the key from the environment, never inlines one", () => {
    expect(out.curl).toContain('Authorization: Bearer $REGULAIT_API_KEY');
    expect(out.curl).toContain('x-api-key: $REGULAIT_API_KEY');
    expect(out.typescript).toContain("apiKey: process.env.REGULAIT_API_KEY");
    expect(out.python).toContain('api_key=os.environ["REGULAIT_API_KEY"]');
    expect(out.anthropic).toContain("apiKey: process.env.REGULAIT_API_KEY");
    for (const s of Object.values(out)) expect(s).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("escapes quotes and newlines in the request for shell, TypeScript and Python", () => {
    const tricky = `It's "quoted"\nline two`;
    const r = buildSnippets({ ...base, prompt: tricky });
    // shell: a single quote closes, escapes and reopens the argument
    expect(r.curl).toContain(`It'\\''s \\"quoted\\"\\nline two`);
    expect(r.curl).not.toContain("It's");
    // TS / Python: a JSON string literal, which both languages accept
    const literal = JSON.stringify(tricky);
    expect(r.typescript).toContain(`content: ${literal}`);
    expect(r.python).toContain(`"content": ${literal}`);
    expect(r.anthropic).toContain(`content: ${literal}`);
  });

  it("uses a stand-in request when the box is empty", () => {
    expect(buildSnippets({ ...base, prompt: "   " }).typescript).toContain('content: "Hello"');
  });
});
