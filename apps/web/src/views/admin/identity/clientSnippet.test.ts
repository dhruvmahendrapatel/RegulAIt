/**
 * Owner decision on #453: the client setup snippet never invents a vendor model id. An empty Model id
 * field renders the neutral <MODEL_ID> token (like <MCP_SERVER_ID>); a filled field is used verbatim.
 */
import { describe, expect, it } from "vitest";
import { buildSnippet } from "./ClientAccessPage";

const WITH_MODEL = ["cursor", "cline", "continue", "generic-anthropic", "generic-openai"];
const VENDOR_MODEL = /\b(claude|gpt|gemini|grok|llama|mistral)-[a-z0-9]/i;
const opts = { base: "https://gw.example.test", serverId: "", projectId: "", model: "" };

describe("buildSnippet model id", () => {
  it.each(WITH_MODEL)("%s: an empty field renders <MODEL_ID> and no vendor model id", (client) => {
    const { snip } = buildSnippet({ ...opts, client });
    expect(snip).toContain("<MODEL_ID>");
    expect(snip).not.toMatch(VENDOR_MODEL);
  });

  it.each(WITH_MODEL)("%s: a filled field is used verbatim", (client) => {
    const { snip } = buildSnippet({ ...opts, client, model: "acme-model-v1" });
    expect(snip).toContain("acme-model-v1");
    expect(snip).not.toContain("<MODEL_ID>");
  });
});
