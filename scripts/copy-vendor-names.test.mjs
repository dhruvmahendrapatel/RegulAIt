import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ALLOWED_LINES, codeOf, copyFiles, findVendorNames, scanText } from "./copy-vendor-names.mjs";

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
    expect(scanText(file, before).map((h) => h.name)).toEqual(["OpenAI", "Anthropic"]);
    expect(scanText(file, after)).toEqual([]);
    // a vendor name added to a real copy file is a hit, not an exception
    const read = (f) => (f === file ? before : "");
    expect(findVendorNames(root, [file], read).hits).toHaveLength(2);
  });

  it("never flags identifiers, slugs, adapter ids, our own Copilot, or comments", () => {
    const f = "apps/web/src/x.tsx";
    expect(scanText(f, `const on = s.anthropicCompatEnabled && kind === "openai_chat" && p === "openai";`)).toEqual([]);
    expect(scanText(f, `<h1>AI governance Copilot</h1>`)).toEqual([]);
    expect(scanText(f, ` * a local Ollama endpoint has no key`)).toEqual([]);
    expect(scanText(f, `const x = 1; // matches OpenAI's shape`)).toEqual([]);
    expect(codeOf(`url: "https://example.test/Claude"`)).toContain("Claude");
    expect(scanText(f, `<p>Seats from GitHub Copilot and Cursor</p>`).map((h) => h.name)).toEqual(["GitHub Copilot", "Cursor"]);
  });

  it("an exception that covers nothing is reported as stale", () => {
    const { stale } = findVendorNames(root, [], () => "");
    expect(stale).toHaveLength(ALLOWED_LINES.length);
    expect(stale).toContain("apps/web/src/views/models/snippets.ts: `client = OpenAI( (covers 0 lines, must cover exactly 1)");
  });

  it("an excepted file has no whole-file pass: a new vendor name on another line of it is a hit", () => {
    const file = "apps/web/src/views/admin/identity/ClientAccessPage.tsx";
    const text = readFileSync(path.join(root, file), "utf8") + `\nconst tip = "Works with Gemini too";\n`;
    const { hits, stale } = findVendorNames(root, [file], () => text);
    expect(hits.map((h) => `${h.name}: ${h.text}`)).toEqual(['Gemini: const tip = "Works with Gemini too";']);
    // the file's reviewed lines are still each covered exactly once
    expect(stale.filter((s) => s.startsWith(file))).toEqual([]);
  });

  it("a second vendor name on an excepted line is a hit; the exception excuses only the names it lists", () => {
    const file = "apps/web/src/views/admin/settings/GettingStartedPage.tsx";
    const line = `  if (s.anthropic) on.push("Anthropic compat on"); x("Gemini")`;
    expect(scanText(file, line).map((h) => h.name)).toEqual(["Anthropic", "Gemini"]);
    const { hits } = findVendorNames(root, [file], () => line);
    expect(hits.map((h) => h.name)).toEqual(["Gemini"]);
  });

  it("every exception's names are in its own line text, so the list says exactly what it excuses", () => {
    for (const a of ALLOWED_LINES) {
      expect(a.names.length).toBeGreaterThan(0);
      for (const n of a.names) expect(a.contains ?? a.equals).toContain(n);
    }
  });

  it("a `//` inside a string literal, a template or JSX text is copy, not a comment", () => {
    const f = "apps/web/src/x.tsx";
    expect(scanText(f, `const tip = "see docs // OpenAI-shaped";`).map((h) => h.name)).toEqual(["OpenAI"]);
    expect(scanText(f, "const tip = `a // ${b} Gemini`;").map((h) => h.name)).toEqual(["Gemini"]);
    expect(scanText(f, `const el = <p>see // Claude</p>;`).map((h) => h.name)).toEqual(["Claude"]);
    expect(scanText(f, `const el = <p>{/* Claude */}ok</p>; // Gemini`)).toEqual([]);
    expect(scanText(f, `const a = 1; /* Gemini */ const b = "c"; // Claude`)).toEqual([]);
    expect(scanText(f, `/**\n * Gemini in a doc block\n */\nconst a = 1;`)).toEqual([]);
  });

  it("the setup guide's other clients are guarded too", () => {
    const f = "apps/web/src/x.tsx";
    expect(scanText(f, `<p>Works with Cline and Roo Code</p>`).map((h) => h.name)).toEqual(["Cline", "Roo Code"]);
  });

  it("an exception that matches more than one line is reported as ambiguous", () => {
    const file = "apps/gateway/src/builder-catalog.ts";
    const line = `C("perplexity", "Perplexity", "Search the web with citations.", "ai", "mcp", ["perplexity"]),`;
    const { hits, stale } = findVendorNames(root, [file], () => `${line}\n${line}\n`);
    expect(hits).toEqual([]);
    expect(stale).toContain(`${file}: C("perplexity", "Perplexity", (covers 2 lines, must cover exactly 1)`);
  });

  it("every exception carries a reason, and the compat labels are the owner's six named exceptions", () => {
    for (const a of ALLOWED_LINES) expect(a.why.length).toBeGreaterThan(10);
    const compat = ALLOWED_LINES.filter((a) => a.why === "owner decision 2026-10-21: compat labels keep vendor-style names");
    expect(compat.map((a) => a.file)).toEqual([
      "apps/web/src/views/admin/identity/ClientAccessPage.tsx",
      "apps/web/src/views/admin/identity/ClientAccessPage.tsx",
      "apps/web/src/views/admin/settings/GettingStartedPage.tsx",
      "apps/web/src/views/admin/settings/GettingStartedPage.tsx",
      "apps/gateway/src/openapi.ts",
      "apps/gateway/src/openapi.ts",
    ]);
  });

  it("covers the shared cost-import and demo-scenario copy, and flags the old scenario title", () => {
    const files = copyFiles(root);
    expect(files).toContain("packages/shared/src/cost-import.ts");
    expect(files).toContain("packages/shared/src/demo-intake/scenario-library.ts");
    const file = "packages/shared/src/demo-intake/scenario-library.ts";
    const before = `    title: "Finance employee uses personal ChatGPT account for spreadsheet analysis",`;
    const after = `    title: "An employee pasting work data into a personal consumer AI chat account",`;
    expect(findVendorNames(root, [file], () => before).hits.map((h) => h.name)).toEqual(["ChatGPT"]);
    expect(findVendorNames(root, [file], () => after).hits).toEqual([]);
  });

  describe("F34: input placeholders and help text are held to more (owner decision 2026-10-21 on #453)", () => {
    const f = "apps/web/src/x.tsx";

    it("a model id or model family in a placeholder is a hit, whatever its case", () => {
      expect(scanText(f, `<Input placeholder="e.g. gemini-0-test" />`).map((h) => h.name)).toEqual(["gemini-0-test"]);
      expect(scanText(f, `<Input placeholder={"e.g. LLAMA-0-test"} />`).map((h) => h.name)).toEqual(["LLAMA-0-test"]);
      expect(scanText(f, "<Input placeholder={`e.g. gpt-0-test for ${x}`} />").map((h) => h.name)).toEqual(["gpt-0-test"]);
      expect(scanText(f, `<Input placeholder="e.g. large-general" />`)).toEqual([]);
    });

    it("help and hint attributes and JSX text are help surfaces; a vendor behind a model is a hit there", () => {
      expect(scanText(f, `<Field hint="the seeded mistral-0-test id" />`).map((h) => h.name)).toEqual(["mistral-0-test"]);
      expect(scanText(f, `<span title="a qwen-0-test id" />`).map((h) => h.name)).toEqual(["qwen-0-test"]);
      expect(scanText(f, `<p>\n  Provider model ids age out (the seeded Google id already did once)\n</p>`).map((h) => h.name)).toEqual(["Google"]);
      expect(scanText(f, `<p>Provider model ids age out (a seeded id already did once)</p>`)).toEqual([]);
    });

    it("outside the help surfaces those words are left alone: identifiers, slugs, values, other attributes", () => {
      expect(scanText(f, `const model = opts.model || "gemini-0-test";`)).toEqual([]);
      expect(scanText(f, `<Option value="google_vertex" data-k="gemini-0-test">x</Option>`)).toEqual([]);
      expect(scanText(f, `const id = "google"; const label = "Google Workspace";`)).toEqual([]);
      expect(scanText("apps/gateway/src/x.ts", `const hint = "gemini-0-test";`)).toEqual([]);
      // a comment in JSX is still not copy
      expect(scanText(f, `<p>{/* gemini-0-test */}ok</p>`)).toEqual([]);
    });

    it("#489 finding 2: what a `{...}` child prints, label and aria-label, and a const a help surface names are hits", () => {
      const names = (src) => scanText(f, src).map((h) => h.name);
      // a string or template literal printed as an element's child
      expect(names(`<p>{"e.g. gemini-0-test"}</p>`)).toEqual(["gemini-0-test"]);
      expect(names("<p>{`e.g. gpt-0-test for ${x}`}</p>")).toEqual(["gpt-0-test"]);
      expect(names(`<>{ok ? "fine" : "try qwen-0-test"}</>`)).toEqual(["qwen-0-test"]);
      expect(names(`<p>{err || "use mistral-0-test"}{busy && "llama-0-test"}{"e.g. " + "deepseek-0-test"}</p>`))
        .toEqual(["mistral-0-test", "llama-0-test", "deepseek-0-test"]);
      // label and aria-label are help surfaces
      expect(names(`<Field label="Model (gemini-0-test)" />`)).toEqual(["gemini-0-test"]);
      expect(names(`<button aria-label="Use the Google model" />`)).toEqual(["Google"]);
      // a same-file const named by a help attribute or a child, wherever it is declared
      expect(names(`const PH = "e.g. gpt-0-test";\nexport const F = () => <Input placeholder={PH} />;`)).toEqual(["gpt-0-test"]);
      expect(names(`const F = () => <p>{TIP}</p>;\nconst TIP = cond ? "ok" : \`try qwen-0-test\`;`)).toEqual(["qwen-0-test"]);
      expect(names(`const A = "gemini-0-test";\nconst B = A;\nconst F = () => <Input title={B} />;`)).toEqual(["gemini-0-test"]);
    });

    it("#489 finding 2: a `{...}` child's slugs, comparisons, calls and attributes are still not copy", () => {
      const src = [
        `const slug = "gemini";`,
        `const PH = "e.g. model-name-v1";`,
        `const F = () => <p>{p === "gemini-0-test" ? "a" : "b"}{fmt("gpt-0-test")}{slug === "x" && <b data-k="qwen-0-test">x</b>}<Input placeholder={PH} /></p>;`,
      ].join("\n");
      expect(scanText(f, src)).toEqual([]);
      // an unreferenced const and a property name that shares a const's name are not help surfaces
      expect(scanText(f, `const PH = "gpt-0-test";\nconst F = () => <Input placeholder={o.PH} />;`)).toEqual([]);
    });

    it("the regex prefilter never skips a file the full scan would flag", () => {
      for (const src of [`<p>{"e.g. gemini-0-test"}</p>`, `const PH = "gpt-0-test";\nconst F = () => <Input placeholder={PH} />;`,
        `<Field label="Google" />`]) {
        expect(scanText(f, src).length).toBeGreaterThan(0);
      }
    });

    it("a proper noun already on the vendor list is reported once, not twice", () => {
      expect(scanText(f, `<p>Works with Gemini</p>`).map((h) => h.name)).toEqual(["Gemini"]);
    });

    it("guard proof: the F34 placeholder put back into the real Agents page fails the guard, and the shipped copy passes", () => {
      const file = "apps/web/src/views/admin/integrations/AgentsPage.tsx";
      const real = readFileSync(path.join(root, file), "utf8");
      expect(findVendorNames(root, [file], () => real).hits).toEqual([]);
      const neutral = `placeholder="e.g. model-name-v1"`;
      expect(real).toContain(neutral);
      const reverted = real.replace(neutral, `placeholder="e.g. gemini-0-test"`);
      expect(findVendorNames(root, [file], () => reverted).hits.map((h) => `${h.line}: ${h.name}`)).toEqual([
        `${real.split("\n").findIndex((l) => l.includes(neutral)) + 1}: gemini-0-test`,
      ]);
    });

    it("the reviewed exceptions still hold on a help surface: an excepted line excuses only its listed names", () => {
      const file = "apps/web/src/views/admin/identity/SsoPage.tsx";
      const line = `        buttons (the bundled Keycloak) shows “Continue with Microsoft / Google / GitHub” on the sign-in page;`;
      expect(scanText(file, `<p>\n${line}\n</p>`).map((h) => h.name)).toEqual(["Microsoft", "Google"]);
      expect(findVendorNames(root, [file], () => `<p>\n${line}\n</p>`).hits).toEqual([]);
      expect(findVendorNames(root, [file], () => `<p>\n${line} Meta too\n</p>`).hits.map((h) => h.name)).toEqual(["Meta"]);
    });
  });
});
