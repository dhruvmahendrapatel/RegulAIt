import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf, copyFiles, findVendorNames, scanText } from "./copy-vendor-names.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("no AI vendor or competitor name in product UI copy (F31)", () => {
  it("the copy surfaces have none outside the reviewed exceptions, and no exception is stale", () => {
    const files = copyFiles(root);
    // non-vacuity: the walk reaches the real tree, including the file F31 was found in
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("apps/gateway/src/shadow-ai.ts");
    expect(files).toContain("apps/web/src/views/admin/cost/CostConsolidationPage.tsx");
    expect(findVendorNames(root, files)).toEqual({ hits: [], stale: [] });
  });

  it("flags the F31 sentence, and passes its rewording", () => {
    const file = "apps/gateway/src/shadow-ai.ts";
    const before = `      why: "the drop-in OpenAI/Anthropic-shaped endpoints mean the application changes a base URL, not its code",`;
    const after = `      why: "the gateway's drop-in, provider-compatible endpoints mean the application changes a base URL, not its code",`;
    expect(scanText(file, before).map((h) => h.name)).toEqual(["OpenAI"]);
    expect(scanText(file, after)).toEqual([]);
    // a vendor name added to a real copy file is a hit, not an exception
    const read = (f) => (f === file ? before : "");
    expect(findVendorNames(root, [file], read).hits).toHaveLength(1);
  });

  it("never flags identifiers, slugs, adapter ids, our own Copilot, or comments", () => {
    const f = "apps/web/src/x.tsx";
    expect(scanText(f, `const on = s.anthropicCompatEnabled && kind === "openai_chat" && p === "openai";`)).toEqual([]);
    expect(scanText(f, `<h1>AI governance Copilot</h1>`)).toEqual([]);
    expect(scanText(f, ` * a local Ollama endpoint has no key`)).toEqual([]);
    expect(scanText(f, `const x = 1; // matches OpenAI's shape`)).toEqual([]);
    expect(codeOf(`url: "https://example.test/Claude"`)).toContain("Claude");
    expect(scanText(f, `<p>Seats from GitHub Copilot and Cursor</p>`).map((h) => h.name)).toEqual(["GitHub Copilot"]);
  });

  it("an exception that covers nothing is reported as stale", () => {
    const { stale } = findVendorNames(root, [], () => "");
    expect(stale.length).toBeGreaterThan(0);
    expect(stale).toContain("apps/web/src/views/models/snippets.ts");
  });
});
