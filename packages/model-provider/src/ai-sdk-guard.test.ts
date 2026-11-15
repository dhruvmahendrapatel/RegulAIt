/**
 * ADR-0253 (P29) — the hard rule: the AI SDK provider packages, never Vercel's AI Gateway.
 *
 * The `ai` core hard-depends on `@ai-sdk/gateway`, and a bare string model id handed to
 * it (`'openai/gpt-x'`) routes to Vercel's hosted gateway. These tests fail the build if:
 *  1. `ai` or `@ai-sdk/gateway` enters any workspace manifest or the lockfile;
 *  2. code that touches the AI SDK passes a string-literal model id, or imports a
 *     provider's DEFAULT instance (`google`, `anthropic`, …), which reads an ambient
 *     API key from the process environment instead of the agent's own credential;
 *  3. the installed provider code names a Vercel host;
 *  4. a dispatch reaches any host but the configured base URL, or any fetch but the
 *     one we inject (the guarded egress path, ADR-0062) — the egress test.
 * No network and no key: every case injects a fetch.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_DEFAULT_BASE, ModelProviderError, resolveModelProvider } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const VERCEL_HOST = /\b(?:[a-z0-9-]+\.)*(?:vercel\.(?:com|app|sh)|ai-gateway\.vercel\.sh)\b/i;

function walk(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

const workspaceDirs = ["apps", "packages"].flatMap((top) => {
  const d = join(repoRoot, top);
  return existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory()) : [];
});

describe("ADR-0253 — no Vercel AI Gateway path exists", () => {
  it("no workspace manifest depends on `ai` or `@ai-sdk/gateway`", () => {
    const offenders: string[] = [];
    for (const dir of [repoRoot, ...workspaceDirs]) {
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (name === "ai" || name === "@ai-sdk/gateway") offenders.push(`${relative(repoRoot, manifest)}: ${field}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the lockfile resolves neither `ai` nor `@ai-sdk/gateway`, even transitively", () => {
    const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/^ {2}'?@ai-sdk\/gateway@/m);
    expect(lock).not.toMatch(/^ {2}'?ai@\d/m);
  });

  it("code touching the AI SDK never passes a bare-string model id or imports a default provider instance", () => {
    const sources = workspaceDirs.flatMap((d) =>
      walk(d, (p) => /\.(?:ts|tsx|mts|js|mjs)$/.test(p) && !p.endsWith("ai-sdk-guard.test.ts")),
    );
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      const touches = /from\s+["'](?:ai|@ai-sdk\/[a-z0-9-]+)["']/.test(text);
      if (!touches) continue;
      const rel = relative(repoRoot, file);
      if (/from\s+["']ai["']/.test(text)) offenders.push(`${rel}: imports the \`ai\` core`);
      // a string literal handed straight to a model slot or a provider factory call
      if (/\bmodel\s*:\s*["'`]/.test(text)) offenders.push(`${rel}: string-literal \`model:\``);
      if (/\.(?:languageModel|chat|responses|messages)\(\s*["'`]/.test(text)) offenders.push(`${rel}: string-literal model id`);
      // `import { google } from "@ai-sdk/google"` — the default instance reads an ambient env key
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@ai-sdk\/([a-z0-9-]+)["']/g)) {
        const names = m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!);
        const bad = names.filter((n) => n && /^[a-z]/.test(n) && !/^create[A-Z]/.test(n));
        if (bad.length) offenders.push(`${rel}: imports default instance(s) ${bad.join(", ")} from @ai-sdk/${m[2]}`);
      }
      if (/import\s+[a-zA-Z_$][\w$]*\s+from\s*["']@ai-sdk\//.test(text)) offenders.push(`${rel}: default import from @ai-sdk/*`);
    }
    expect(offenders).toEqual([]);
  });

  it("the installed AI SDK provider code names no Vercel host", () => {
    const sdkRoot = join(here, "..", "node_modules", "@ai-sdk");
    const pkgs = readdirSync(sdkRoot);
    expect(pkgs, "the provider packages must be installed for this check to mean anything").toContain("google");
    const hits: string[] = [];
    for (const pkg of pkgs) {
      const dist = join(sdkRoot, pkg, "dist");
      // the realpath of a pnpm symlink is followed by readdir/stat
      for (const f of walkAll(dist)) {
        if (!/\.(?:js|mjs|cjs)$/.test(f)) continue;
        if (VERCEL_HOST.test(readFileSync(f, "utf8"))) hits.push(`@ai-sdk/${pkg}/${relative(join(sdkRoot, pkg), f)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

function walkAll(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

describe("ADR-0253 — egress: every AI SDK request goes to the configured host, through our fetch", () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        responseId: "r-egress",
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("default base: only the Gemini host, never a Vercel host, and never the global fetch", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the AI SDK reached the global fetch — it must only use the injected, guarded fetch");
    });
    const urls: string[] = [];
    const provider = resolveModelProvider({ provider: "google", apiKey: "k", baseUrl: null }, async (u) => {
      urls.push(String(u));
      return ok();
    });
    await provider.dispatch({ model: "gemini-2.5-pro", input: "x" });
    await provider.dispatch({ model: "gemini-2.5-pro", input: "x", onText: () => {} }).catch(() => {});
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith(`${GOOGLE_DEFAULT_BASE}/models/`)).toBe(true);
      expect(new URL(u).host).toBe("generativelanguage.googleapis.com");
      expect(u).not.toMatch(VERCEL_HOST);
    }
  });

  it("air-gapped: a configured private base URL is the only host reached", async () => {
    const urls: string[] = [];
    const provider = resolveModelProvider(
      { provider: "google", apiKey: "k", baseUrl: "https://llm-bridge.internal.example/v1beta/" },
      async (u) => {
        urls.push(String(u));
        return ok();
      },
    );
    await provider.dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect(urls).toEqual(["https://llm-bridge.internal.example/v1beta/models/gemini-2.5-pro:generateContent"]);
  });

  it("an egress-guard refusal thrown by the injected fetch reaches the caller unchanged", async () => {
    class EgressDenied extends Error {
      override name = "EgressDenied";
    }
    const provider = resolveModelProvider({ provider: "google", apiKey: "k", baseUrl: null }, async () => {
      throw new EgressDenied("host not on the allow-list");
    });
    const err = await provider.dispatch({ model: "gemini-2.5-pro", input: "x" }).catch((e: unknown) => e);
    // the governance decision must stay findable on the cause chain, not be flattened to a network blip
    let found = false;
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) if (e instanceof EgressDenied) found = true;
    expect(found).toBe(true);
  });

  it("never falls back to an ambient GOOGLE_GENERATIVE_AI_API_KEY", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "ambient-key-must-not-be-used");
    expect(() => resolveModelProvider({ provider: "google", apiKey: "", baseUrl: null })).toThrow(ModelProviderError);
    const seen: Array<string | null> = [];
    const provider = resolveModelProvider({ provider: "google", apiKey: "agent-key", baseUrl: null }, async (_u, init) => {
      seen.push(new Headers(init?.headers).get("x-goog-api-key"));
      return ok();
    });
    await provider.dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect(seen).toEqual(["agent-key"]);
  });
});
