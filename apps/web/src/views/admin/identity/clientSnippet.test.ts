/**
 * Owner decision on #453: the client setup snippet never invents a vendor model id. An empty Model id
 * field renders the neutral <MODEL_ID> token (like <MCP_SERVER_ID>); a filled field is used verbatim.
 * The cases come from the page's own client list, so a new client kind is covered automatically.
 */
import { describe, expect, it } from "vitest";
import { buildSnippet, CLIENTS } from "./ClientAccessPage";

// Kinds whose snippet carries no model line (the client picks the model itself).
const NO_MODEL = ["claude-code", "zed"];
const ALL = CLIENTS.map((c) => c.v);
const WITH_MODEL = ALL.filter((k) => !NO_MODEL.includes(k));
const VENDOR_MODEL = /\b(claude|gpt|gemini|grok|llama|mistral)-[a-z0-9]/i;
const opts = { base: "https://gw.example.test", serverId: "", projectId: "", model: "" };

describe("buildSnippet model id", () => {
  it("every no-model kind is a real client kind", () => {
    for (const k of NO_MODEL) expect(ALL).toContain(k);
  });

  it.each(ALL)("%s: an empty field renders no vendor model id", (client) => {
    const { snip } = buildSnippet({ ...opts, client });
    expect(snip).not.toMatch(VENDOR_MODEL);
  });

  it.each(WITH_MODEL)("%s: an empty field renders <MODEL_ID>", (client) => {
    const { snip } = buildSnippet({ ...opts, client });
    expect(snip).toContain("<MODEL_ID>");
  });

  it.each(WITH_MODEL)("%s: a filled field is used verbatim", (client) => {
    const { snip } = buildSnippet({ ...opts, client, model: "acme-model-v1" });
    expect(snip).toContain("acme-model-v1");
    expect(snip).not.toContain("<MODEL_ID>");
  });

  it.each(NO_MODEL)("%s: renders no model line at all", (client) => {
    expect(buildSnippet({ ...opts, client }).snip).not.toContain("<MODEL_ID>");
    expect(buildSnippet({ ...opts, client, model: "acme-model-v1" }).snip).not.toContain("acme-model-v1");
  });
});
