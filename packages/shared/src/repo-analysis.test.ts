// ADR-0195 SD1: the pure repo analyser over a synthetic in-memory repo.
// Key-shaped strings are assembled at runtime so no secret-shaped literal
// sits in this file (gitleaks runs in CI).

import { describe, expect, it } from "vitest";
import { analyseRepo, hostsInLine, npmPackageOf, type RepoFileRead } from "./repo-analysis.js";
import { readManifest, manifestKindForPath } from "./repo-manifests.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const anthropicKey = () => ["sk", "ant", "api03", "Q".repeat(44)].join("-");
const googleKey = () => "AI" + "za" + "B".repeat(35);

function repo(files: Record<string, string>, sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  return {
    reads,
    entries: Object.keys(files).map((path) => ({ path, size: sizes[path] ?? Buffer.byteLength(files[path]!) })),
    readFile: async (path: string): Promise<RepoFileRead> => {
      reads.push(path);
      const c = files[path];
      return c === undefined ? { status: "not_found" } : { status: "ok", content: c };
    },
  };
}

describe("analyseRepo", () => {
  it("emits dependency, import, config, MCP, extension, env-name, endpoint and key observations", async () => {
    const key = anthropicKey();
    const r = repo({
      "package.json": JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^1", "left-pad": "1" } }, null, 2),
      "svc/requirements.txt": "flask==3\nlanggraph>=0.2\n",
      "svc/pyproject.toml": '[project]\nname = "x"\ndependencies = ["pydantic-ai>=1", "requests"]\n',
      "jvm/pom.xml": "<project><dependencies><dependency><groupId>com.openai</groupId><artifactId>openai-java</artifactId></dependency></dependencies></project>",
      "jvm/build.gradle.kts": 'dependencies {\n  implementation("dev.langchain4j:langchain4j:1.0.0")\n}\n',
      "net/App.csproj": '<Project><ItemGroup><PackageReference Include="Azure.AI.OpenAI" Version="2.0.0" /></ItemGroup></Project>',
      "rb/Gemfile": 'source "https://rubygems.org"\ngem "ruby-openai"\n',
      "rs/Cargo.toml": '[dependencies]\nasync-openai = "0.20"\nai = { package = "ollama-rs", version = "0.2" }\n',
      "go.mod": "module x\n\nrequire github.com/openai/openai-go v1.0.0\n",
      "src/app.py": `from google import genai\nimport os\nclient = Client(base_url="https://api.groq.com/openai/v1")\nKEY = "${key}"\n`,
      "web/index.ts": 'import Anthropic from "@anthropic-ai/sdk";\nimport { x } from "./local";\nconst m = await import("@ai-sdk/openai");\n',
      ".github/copilot-instructions.md": "Use tabs.",
      ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "/usr/local/bin/npx", args: ["-y", "secret-arg"], env: { TOKEN: "do-not-keep" } }, remote: { type: "http", url: "https://mcp.example.test/mcp" } } }),
      ".vscode/extensions.json": JSON.stringify({ recommendations: ["GitHub.copilot", "esbenp.prettier-vscode"] }),
      ".env.example": "OPENAI_API_KEY=\nDATABASE_URL=postgres://localhost\n# GROQ_API_KEY=\n",
      "config/settings.yaml": `google_key: ${googleKey()}\n`,
      "node_modules/openai/package.json": '{"dependencies":{"openai":"1"}}',
      "README.md": "nothing here",
    });
    let hookArg: unknown = null;
    const res = await analyseRepo({
      repo: "acme/app",
      commitSha: SHA,
      entries: r.entries,
      readFile: r.readFile,
      author: { name: "Dev One", email: "dev1@example.test" },
      pseudonymiseAuthor: async (a) => {
        hookArg = a;
        return "author:hmac:abc";
      },
    });
    const by = (k: string) => res.observations.filter((o) => o.kind === k);
    expect(by("dependency").map((o) => `${o.ecosystem}:${o.packageName}`).sort()).toEqual(
      [
        "cargo:async-openai",
        "cargo:ollama-rs",
        "go:github.com/openai/openai-go",
        "gradle:dev.langchain4j:langchain4j",
        "maven:com.openai:openai-java",
        "npm:@anthropic-ai/sdk",
        "nuget:Azure.AI.OpenAI",
        "pypi:langgraph",
        "pypi:pydantic-ai",
        "rubygems:ruby-openai",
      ].sort(),
    );
    expect(by("source_import").map((o) => `${o.path}:${o.line}:${o.packageName}`).sort()).toEqual(
      ["src/app.py:1:google-genai", "web/index.ts:1:@anthropic-ai/sdk", "web/index.ts:3:@ai-sdk/openai"].sort(),
    );
    expect(by("assistant_config").map((o) => o.catalogEntryId).sort()).toEqual(["cfg-github-copilot-instructions", "cfg-mcp-json"]);
    expect(by("mcp_server").map((o) => o.mcpServer)).toEqual([
      { name: "files", transport: "stdio", command: "npx", host: null },
      { name: "remote", transport: "http", command: null, host: "mcp.example.test" },
    ]);
    expect(by("ide_extension").map((o) => o.extensionId)).toEqual(["github.copilot"]);
    // ADR-0195 lane A6: the presence signature id only, never the variable name
    expect(by("env_presence").map((o) => `${o.path}:${o.presenceSignatureId}`)).toEqual([".env.example:env.openai.api-key"]);
    expect(by("endpoint_reference").map((o) => `${o.path}:${o.host}`)).toContain("src/app.py:api.groq.com");

    const keys = by("ai_key");
    expect(keys.map((o) => ({ path: o.path, line: o.line, rule: o.key!.ruleId, provider: o.provider }))).toEqual(
      expect.arrayContaining([
        { path: "src/app.py", line: 4, rule: "dlp.secret.anthropic_key", provider: "anthropic" },
        { path: "config/settings.yaml", line: 1, rule: "dlp.secret.google_api_key", provider: "google" },
      ]),
    );
    for (const k of keys) expect(k.key!.fragment.length).toBeLessThanOrEqual(8);

    // data minimisation: nothing read survives except the digest and the bounded fields above
    const serialised = JSON.stringify(res);
    for (const forbidden of [key, googleKey(), "secret-arg", "do-not-keep", "Use tabs.", "Dev One", "dev1@example.test"]) {
      expect(serialised.includes(forbidden), forbidden).toBe(false);
    }
    expect(res.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.authorRef).toBe("author:hmac:abc");
    expect(hookArg).toEqual({ name: "Dev One", email: "dev1@example.test" });
    expect(r.reads).not.toContain("node_modules/openai/package.json");
    expect(r.reads).not.toContain("README.md");
    expect(res.observations.every((o) => o.commitSha === SHA)).toBe(true);
  });

  it("reports env-variable presence in .env templates, Dockerfiles and CI YAML as signature ids only (lane A6)", async () => {
    const value = "VALUE" + "MUSTNOTLEAK";
    const r = repo({
      ".env.sample": `export ANTHROPIC_API_KEY=${value}\nUNRELATED_NAME=1\n`,
      "Dockerfile": `FROM scratch\nENV OPENAI_API_KEY=${value}\nARG HF_TOKEN\n`,
      "svc/api.dockerfile": "ENV MISTRAL_API_KEY x\n",
      ".github/workflows/ci.yml": `jobs:\n  t:\n    env:\n      GEMINI_API_KEY: \${{ secrets.${value} }}\n`,
      ".github/workflows/nested/skip.yml": "env:\n  DEEPSEEK_API_KEY: x\n",
      ".gitlab-ci.yml": "variables:\n  - name: PERPLEXITY_API_KEY\n",
      "docs/notes.yml": "CURSOR_API_KEY: x\n",
    });
    const res = await analyseRepo({ repo: "a/b", commitSha: SHA, entries: r.entries, readFile: r.readFile });
    const presence = res.observations.filter((o) => o.kind === "env_presence").map((o) => `${o.path}:${o.presenceSignatureId}`);
    expect(presence.sort()).toEqual(
      [
        ".env.sample:env.anthropic.api-key",
        ".github/workflows/ci.yml:env.google.gemini-api-key",
        ".gitlab-ci.yml:env.perplexity.api-key",
        "Dockerfile:env.huggingface.token",
        "Dockerfile:env.openai.api-key",
        "svc/api.dockerfile:env.mistral.api-key",
      ].sort(),
    );
    // a nested workflow folder and a non-CI YAML are not CI configs; neither is scanned for env names
    const serialised = JSON.stringify(res);
    for (const forbidden of [value, "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "UNRELATED_NAME", "DEEPSEEK", "CURSOR"]) {
      expect(serialised.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("takes the program's basename from the FIRST token, never an argument fragment", async () => {
    const secret = "SECRET" + "PART";
    const mcp = JSON.stringify({
      mcpServers: {
        a: { command: `npx -y @acme/server-x --token Zm9vYmFy/${secret}` },
        b: { command: "node /home/alice/private/run.js" },
        c: { command: "/usr/local/bin/uvx", args: ["x"] },
        d: { command: "C:\\tools\\srv.exe --flag a\\b" },
      },
    });
    const r = repo({ ".mcp.json": mcp });
    const res = await analyseRepo({ repo: "a/b", commitSha: SHA, entries: r.entries, readFile: r.readFile });
    const cmds = res.observations.filter((o) => o.kind === "mcp_server").map((o) => o.mcpServer!.command);
    expect(cmds).toEqual(["npx", "node", "uvx", "srv.exe"]);
    expect(JSON.stringify(res)).not.toContain(secret);
    expect(JSON.stringify(res)).not.toContain("alice");
  });

  it("drops the author when no pseudonym hook is given", async () => {
    const r = repo({ "package.json": "{}" });
    const res = await analyseRepo({ repo: "a/b", commitSha: SHA, entries: r.entries, readFile: r.readFile, author: { name: "X", email: "x@example.test" } });
    expect(res.authorRef).toBeNull();
    expect(JSON.stringify(res)).not.toContain("x@example.test");
  });

  it("keeps an observation the admin catalogue knows but the compiled one does not", async () => {
    const r = repo({ "package.json": JSON.stringify({ dependencies: { "@acme/in-house-llm": "1" } }) });
    const res = await analyseRepo({
      repo: "a/b",
      commitSha: SHA,
      entries: r.entries,
      readFile: r.readFile,
      alsoKeep: (o) => o.kind === "dependency" && o.value === "@acme/in-house-llm",
    });
    expect(res.observations).toEqual([
      expect.objectContaining({ kind: "dependency", packageName: "@acme/in-house-llm", catalogEntryId: null, provider: null }),
    ]);
  });

  it("enforces file-size, file-count, byte and observation caps and reports them", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`p${i}/requirements.txt`] = "openai\n";
    files["big/package.json"] = "{}";
    const r = repo(files, { "big/package.json": 10_000_000 });
    const res = await analyseRepo({ repo: "a/b", commitSha: SHA, entries: r.entries, readFile: r.readFile, limits: { maxFilesRead: 3, maxObservations: 2 } });
    expect(res.stats.filesRead).toBe(3);
    expect(res.stats.skippedTooLarge).toBe(1);
    expect(res.stats.skippedByFileCap).toBe(7);
    expect(res.observations).toHaveLength(2);
    expect(res.stats.observationsDropped).toBe(1);
    expect(res.stats.truncated).toBe(true);
    expect(r.reads).not.toContain("big/package.json");
  });

  it("an unreadable manifest or JSONC config is counted, never thrown", async () => {
    const r = repo({ "package.json": "{not json", ".vscode/mcp.json": '{ // comment\n "servers": {} }' });
    const res = await analyseRepo({ repo: "a/b", commitSha: SHA, entries: r.entries, readFile: r.readFile });
    expect(res.stats.unreadableManifests).toBe(1);
    expect(res.stats.unparsedConfigs).toBe(1);
    expect(res.observations.map((o) => o.kind)).toEqual(["assistant_config"]);
  });
});

describe("repo manifest readers", () => {
  it("classifies manifest paths", () => {
    expect(manifestKindForPath("a/requirements-dev.txt")).toBe("requirements_txt");
    expect(manifestKindForPath("gradle/libs.versions.toml")).toBe("gradle_catalog");
    expect(manifestKindForPath("src/Directory.Packages.props")).toBe("nuget_project");
    expect(manifestKindForPath("src/main.py")).toBeNull();
  });

  it("reads poetry, Pipfile, packages.config and version catalogues", () => {
    expect(readManifest("pyproject_toml", '[tool.poetry.dependencies]\npython = "^3.11"\nanthropic = "*"\n').dependencies.map((d) => d.name)).toEqual(["anthropic"]);
    expect(readManifest("pipfile", '[packages]\nopenai = "*"\n[dev-packages]\npytest = "*"\n').dependencies.map((d) => d.name)).toEqual(["openai", "pytest"]);
    expect(readManifest("packages_config", '<?xml version="1.0"?><packages><package id="OpenAI" version="2.0.0" /></packages>').dependencies).toEqual([
      { ecosystem: "nuget", name: "OpenAI", line: 1 },
    ]);
    expect(readManifest("gradle_catalog", '[libraries]\nai = { module = "com.anthropic:anthropic-java", version = "1" }\n').dependencies.map((d) => d.name)).toEqual([
      "com.anthropic:anthropic-java",
    ]);
    expect(readManifest("pyproject_toml", "not = [toml").ok).toBe(false);
  });

  it("does not expand XML entities", () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x "com.openai">]><project><dependencies><dependency><groupId>&x;</groupId><artifactId>openai-java</artifactId></dependency></dependencies></project>';
    const deps = readManifest("pom_xml", evil).dependencies;
    expect(deps.some((d) => d.name === "com.openai:openai-java")).toBe(false);
  });
});

describe("line helpers", () => {
  it("finds hosts after :// and in quotes", () => {
    expect(hostsInLine('x = "https://api.openai.com/v1"; y = \'api.mistral.ai\'')).toEqual(["api.openai.com", "api.mistral.ai"]);
    // index-and-scan only: adversarial runs finish inside the default test timeout
    expect(hostsInLine("://".repeat(50_000))).toEqual([]);
    expect(hostsInLine('"'.repeat(50_000))).toEqual([]);
  });

  it("resolves npm specifiers to package names", () => {
    expect(npmPackageOf("@langchain/core/messages")).toBe("@langchain/core");
    expect(npmPackageOf("openai/resources")).toBe("openai");
    expect(npmPackageOf("./x")).toBeNull();
    expect(npmPackageOf("node:fs")).toBeNull();
  });
});
