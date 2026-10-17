import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLI_NAME_PATTERN,
  cliBaseName,
  ENV_NAME_MAX,
  ENV_NAME_PATTERN,
  envNamePresenceInText,
  isEnvName,
  matchCliNames,
  matchEnvNames,
  PRESENCE_NAMES_MAX,
  PRESENCE_SIGNATURE_ID_PATTERN,
  PRESENCE_SIGNATURES_V1,
  PRESENCE_TEXT_MAX,
  type PresenceSignature,
} from "./index.js";
import { AI_SIGNATURE_KINDS } from "../shadow-ai.js";

const ids = (m: { signatureId: string }[]) => m.map((x) => x.signatureId);
// synthetic placeholder values only, built at runtime so no secret-shaped literal exists
const fakeValue = () => ["x", "y", "z"].join("-").repeat(8);

describe("ADR-0195 A6: the presence catalogue is data", () => {
  it("is pinned by entry count and SHA-256", () => {
    expect(PRESENCE_SIGNATURES_V1).toHaveLength(16);
    const digest = createHash("sha256").update(JSON.stringify(PRESENCE_SIGNATURES_V1)).digest("hex");
    expect(digest).toBe("07b923742caf70d6732c082b44acb9763d283ee109936be07f761b9d5f96a4a7");
  });

  it("every row is well-formed, unique and frozen", () => {
    const seenIds = new Set<string>();
    const seenValues = new Set<string>();
    for (const s of PRESENCE_SIGNATURES_V1) {
      expect(s.id).toMatch(PRESENCE_SIGNATURE_ID_PATTERN);
      expect(s.id.startsWith(s.kind === "env_name" ? "env." : "cli.")).toBe(true);
      if (s.kind === "env_name") expect(isEnvName(s.value)).toBe(true);
      else expect(s.value).toMatch(CLI_NAME_PATTERN);
      expect(s.provenance).toMatch(/12b7bbf733032d7822b2fb16e88b0f7a1399d1da/);
      expect(seenIds.has(s.id)).toBe(false);
      expect(seenValues.has(`${s.kind}:${s.value}`)).toBe(false);
      seenIds.add(s.id);
      seenValues.add(`${s.kind}:${s.value}`);
      expect(Object.isFrozen(s)).toBe(true);
    }
    expect(Object.isFrozen(PRESENCE_SIGNATURES_V1)).toBe(true);
  });

  it("is not yet an admin-catalogue kind (the 0202 CHECK is closed; widening needs a migration)", () => {
    expect(AI_SIGNATURE_KINDS as readonly string[]).not.toContain("env_name");
    expect(AI_SIGNATURE_KINDS as readonly string[]).not.toContain("cli");
  });
});

describe("env names: the endpoint agent's shape", () => {
  it("accepts ^[A-Z][A-Z0-9_]*$ up to 128 characters only", () => {
    expect(ENV_NAME_PATTERN.source).toBe("^[A-Z][A-Z0-9_]*$");
    expect(isEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isEnvName("A".repeat(ENV_NAME_MAX))).toBe(true);
    expect(isEnvName("A".repeat(ENV_NAME_MAX + 1))).toBe(false);
    for (const bad of ["", "openai_api_key", "_OPENAI", "1OPENAI", "OPENAI-API-KEY", "OPENAI API", "OPENAI_API_KEY=x", "ÖPENAI"]) {
      expect(isEnvName(bad)).toBe(false);
    }
  });
});

describe("matchEnvNames", () => {
  it("records only the signature id, never the observed names", () => {
    const m = matchEnvNames(["PATH", "OPENAI_API_KEY", "HF_TOKEN", "OPENAI_API_KEY", "MY_INTERNAL_THING"]);
    expect(ids(m)).toEqual(["env.huggingface.token", "env.openai.api-key"]);
    const body = JSON.stringify(m);
    for (const name of ["PATH", "OPENAI_API_KEY", "HF_TOKEN", "MY_INTERNAL_THING"]) expect(body).not.toContain(name);
    expect(Object.keys(m[0]!).sort()).toEqual(["confidence", "kind", "provider", "signatureId"]);
  });

  it("is whole-name, case-sensitive equality (no prefix, no substring, no lower case)", () => {
    expect(matchEnvNames(["OPENAI_API_KEY_2", "MY_OPENAI_API_KEY", "openai_api_key", "OPENAI_API"])).toEqual([]);
  });

  it("skips a value-shaped entry rather than matching inside it", () => {
    expect(matchEnvNames([`OPENAI_API_KEY=${fakeValue()}`])).toEqual([]);
  });

  it("marks a generic name low confidence", () => {
    expect(matchEnvNames(["GOOGLE_API_KEY"])).toEqual([
      { signatureId: "env.google.api-key", provider: "google", kind: "env_name", confidence: "low" },
    ]);
  });

  it("matches only the catalogue it is given (admin rows, later)", () => {
    const own: PresenceSignature[] = [
      { id: "env.acme.key", provider: "acme-ai", kind: "env_name", value: "ACME_AI_KEY", confidence: "high", toolId: "acme", provenance: "admin" },
    ];
    expect(ids(matchEnvNames(["ACME_AI_KEY", "OPENAI_API_KEY"], own))).toEqual(["env.acme.key"]);
  });

  it("refuses more than the bound instead of cutting silently", () => {
    expect(() => matchEnvNames(Array.from({ length: PRESENCE_NAMES_MAX + 1 }, () => "PATH"))).toThrow(RangeError);
  });
});

describe("matchCliNames", () => {
  it("matches a binary by base name, on any OS path, without .exe", () => {
    expect(cliBaseName("/usr/local/bin/claude")).toBe("claude");
    expect(cliBaseName("C:\\Users\\u\\AppData\\Roaming\\npm\\Codex.EXE")).toBe("codex");
    expect(cliBaseName("gemini")).toBe("gemini");
    expect(cliBaseName("/opt/bin/")).toBeNull();
    expect(ids(matchCliNames(["/usr/local/bin/claude", "C:\\npm\\codex.exe", "/usr/bin/git"]))).toEqual([
      "cli.anthropic.claude",
      "cli.openai.codex",
    ]);
  });

  it("is whole-name equality and medium confidence", () => {
    expect(matchCliNames(["claude-desktop", "xgemini", "codex2"])).toEqual([]);
    expect(matchCliNames(["gemini"])[0]!.confidence).toBe("medium");
  });
});

describe("envNamePresenceInText", () => {
  it("dotenv: finds declared names, ignores comments, never returns names or values", () => {
    const v = fakeValue();
    const text = [
      "# OPENAI_API_KEY= is commented out",
      `export ANTHROPIC_API_KEY=${v}`,
      "MISTRAL_API_KEY =",
      "PATH=/usr/bin",
      `NOT_AI=${v} OPENAI_API_KEY=${v}`,
    ].join("\r\n");
    const m = envNamePresenceInText(text, "dotenv");
    expect(ids(m)).toEqual(["env.anthropic.api-key", "env.mistral.api-key"]);
    const body = JSON.stringify(m);
    expect(body).not.toContain(v);
    expect(body).not.toContain("ANTHROPIC_API_KEY");
  });

  it("dockerfile: ENV and ARG, either form", () => {
    const text = [
      "FROM node:22",
      "ARG HF_TOKEN",
      "env DEEPSEEK_API_KEY placeholder",
      "ENV GEMINI_API_KEY=x OTHER=y",
      "RUN echo OPENAI_API_KEY=x",
      "ENVOPENAI_API_KEY=x",
    ].join("\n");
    expect(ids(envNamePresenceInText(text, "dockerfile"))).toEqual([
      "env.deepseek.api-key",
      "env.google.gemini-api-key",
      "env.huggingface.token",
    ]);
  });

  it("ci_yaml: mapping keys, list items and name: entries", () => {
    const text = [
      "jobs:",
      "  test:",
      "    env:",
      "      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
      "    environment:",
      "      - PERPLEXITY_API_KEY=placeholder",
      "variables:",
      "  - name: CURSOR_API_KEY",
      "    value: placeholder",
      "  - name: HF_TOKEN extra",
      "script: echo DEEPSEEK_API_KEY: here",
    ].join("\n");
    expect(ids(envNamePresenceInText(text, "ci_yaml"))).toEqual([
      "env.cursor.api-key",
      "env.openai.api-key",
      "env.perplexity.api-key",
    ]);
  });

  it("an over-long name is not truncated into a match", () => {
    expect(envNamePresenceInText(`OPENAI_API_KEY${"X".repeat(200)}=1`, "dotenv")).toEqual([]);
  });

  it("refuses an over-long text and an unknown format", () => {
    expect(() => envNamePresenceInText("A".repeat(PRESENCE_TEXT_MAX + 1), "dotenv")).toThrow(RangeError);
    expect(() => envNamePresenceInText("A=1", "toml" as never)).toThrow(RangeError);
  });
});
