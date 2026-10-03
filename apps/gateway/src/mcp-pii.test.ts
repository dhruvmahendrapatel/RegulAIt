import { describe, expect, it } from "vitest";
import { prepareMcpPiiAction, redactMcpResult } from "./mcp-pii.js";
import { enforcePII } from "./projects.js";

const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
const prepare = (text: string, inputSchema = schema) => prepareMcpPiiAction(null, { text }, [], inputSchema);

describe("MCP prepared PII action", () => {
  it("binds schema and both payloads, with immutable effective bytes", () => {
    const a = prepare("alice@example.test");
    const b = prepare("bob@example.test");
    expect(a.effectiveArguments).toEqual(b.effectiveArguments);
    expect(a.argumentsDigest).not.toBe(b.argumentsDigest);
    expect(prepare("alice@example.test", { ...schema, description: "new contract" } as typeof schema).argumentsDigest).not.toBe(a.argumentsDigest);
    expect(Object.isFrozen(a.effectiveArguments)).toBe(true);
    expect(JSON.stringify(a.argumentsPreview)).not.toContain("alice@example.test");
    expect(a.effectiveArguments.text).toBe("[EMAIL]");
  });

  it.each([
    null,
    { type: "object", properties: { text: { type: "string", format: "email" } } },
    { type: "object", properties: { text: { enum: ["alice@example.test"] } } },
    { type: "object", $async: true },
    { type: "object", $id: "shared-schema" },
    { type: "object", properties: { text: { $ref: "https://example.test/schema" } } },
    { type: "object", $schema: "unsupported-draft" },
    { type: "object", unsupportedAssertion: true },
    { type: "object", properties: { text: { type: "string", format: "unknown-format" } } },
    { type: "object", required: "invalid-schema" },
  ])("refuses missing, incompatible, or unsupported schema: %j", (inputSchema) => {
    expect(() => prepareMcpPiiAction(null, { text: "alice@example.test" }, [], inputSchema)).toThrow("MCP PII transformation or input schema validation failed");
  });

  it("refuses unsafe arguments without exposing a key or value in the error", () => {
    for (const args of [{ "alice@example.test": "secret" }, { text: 4111111111111111 }]) {
      expect(() => prepareMcpPiiAction(null, args, [], schema)).toThrow("MCP PII transformation or input schema validation failed");
    }
  });

  it("redacts text and structured output together", () => {
    const result = redactMcpResult({ content: [{ type: "text", text: "alice@example.test" }], structuredContent: { owner: "bob@example.test" } }, []);
    expect(result.hits).toEqual([{ category: "email", count: 2 }]);
    expect(result.value).toEqual({ content: [{ type: "text", text: "[EMAIL]" }], structuredContent: { owner: "[EMAIL]" } });
  });

  it.each([
    { content: [{ type: "image", data: "YWxpY2VAZXhhbXBsZS50ZXN0", mimeType: "image/png" }] },
    { content: [{ type: "resource_link", uri: "https://example.test", name: "link" }] },
    { content: [{ type: "text", text: "clean", annotations: { audience: ["user"] } }] },
    { content: [], _meta: { opaque: "value" } },
  ])("withholds opaque or extension result shapes: %j", (result) => {
    expect(() => redactMcpResult(result, [])).toThrow();
  });

  it("legacy enforcement cannot silently accept an unimplemented redaction mode", () => {
    expect(() => enforcePII("redact", { input: "clean" }, [])).toThrow("prepared dispatch path");
  });
});
