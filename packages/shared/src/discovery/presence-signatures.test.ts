import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPresenceCatalogue,
  CLI_NAME_PATTERN,
  cliBaseName,
  ENV_NAME_MAX,
  ENV_NAME_PATTERN,
  envNamePresenceInText,
  isEnvName,
  isPresenceSignature,
  matchCliNames,
  matchEnvNames,
  PRESENCE_NAMES_MAX,
  PRESENCE_SIGNATURE_ID_PATTERN,
  PRESENCE_SIGNATURES_V1,
  PRESENCE_TEXT_MAX,
  presenceSignatureById,
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

describe("review of #419: catalogue validation and the guards a mutation pass found untested", () => {
  const good: PresenceSignature = { id: "env.acme.key", provider: "acme-ai", kind: "env_name", value: "ACME_AI_KEY", confidence: "high", toolId: "acme", provenance: "admin" };

  it("isPresenceSignature accepts every v1 row and refuses malformed rows", () => {
    for (const r of PRESENCE_SIGNATURES_V1) expect(isPresenceSignature(r), r.id).toBe(true);
    expect(isPresenceSignature(good)).toBe(true);
    for (const bad of [
      { ...good, id: "cli.acme.key" }, // id prefix does not fit the kind
      { ...good, id: "ENV.ACME" },
      { ...good, value: "acme_ai_key" }, // env value not upper case
      { ...good, value: "ACME AI KEY" },
      { ...good, value: "A".repeat(129) },
      { ...good, kind: "cli", id: "cli.acme.x", value: "ACME" }, // CLI value is lower case
      { ...good, kind: "cli", id: "cli.acme.x", value: "x".repeat(65) },
      { ...good, kind: "regex" },
      { ...good, confidence: "certain" },
      { ...good, provider: "Acme AI" },
      { ...good, provenance: "" },
      null,
      "env.acme.key",
    ]) {
      expect(isPresenceSignature(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("every matcher refuses a malformed or duplicated catalogue instead of matching against it", () => {
    const wrongShape = [{ ...good, value: "acme_ai_key" }] as PresenceSignature[];
    const dup = [good, { ...good }];
    for (const cat of [wrongShape, dup]) {
      expect(() => matchEnvNames(["ACME_AI_KEY"], cat)).toThrow(TypeError);
      expect(() => matchCliNames(["acme"], cat)).toThrow(TypeError);
      expect(() => envNamePresenceInText("ACME_AI_KEY=1", "dotenv", cat)).toThrow(TypeError);
      expect(() => assertPresenceCatalogue(cat)).toThrow(TypeError);
    }
    expect(() => assertPresenceCatalogue(PRESENCE_SIGNATURES_V1)).not.toThrow();
  });

  it("presenceSignatureById resolves known ids only", () => {
    expect(presenceSignatureById("env.openai.api-key")?.value).toBe("OPENAI_API_KEY");
    expect(presenceSignatureById("env.acme.key")).toBeNull();
    expect(presenceSignatureById("env.acme.key", [good])?.provider).toBe("acme-ai");
    expect(presenceSignatureById("OPENAI_API_KEY")).toBeNull();
  });

  it("cliBaseName refuses a blank, an over-long base name and an over-long input", () => {
    expect(cliBaseName("a b")).toBeNull();
    expect(cliBaseName("x".repeat(65))).toBeNull();
    expect(cliBaseName("x".repeat(64))).toBe("x".repeat(64));
    // the tail alone would be a match: the input bound is what refuses it
    expect(cliBaseName(`${"a/".repeat(2_500)}claude`)).toBeNull();
    expect(matchCliNames([`${"a/".repeat(2_500)}claude`])).toEqual([]);
  });

  it("dotenv needs `=` after the name", () => {
    expect(envNamePresenceInText("OPENAI_API_KEY\n", "dotenv")).toEqual([]);
    expect(envNamePresenceInText("OPENAI_API_KEY value\n", "dotenv")).toEqual([]);
    expect(ids(envNamePresenceInText("OPENAI_API_KEY =\n", "dotenv"))).toEqual(["env.openai.api-key"]);
  });

  it("dockerfile needs the name to end at `=`, a blank or the end of the line", () => {
    expect(envNamePresenceInText("ENV OPENAI_API_KEY:x\n", "dockerfile")).toEqual([]);
    expect(envNamePresenceInText("ENV OPENAI_API_KEY#\n", "dockerfile")).toEqual([]);
    expect(envNamePresenceInText("ENV OPENAI_API_KEY-x\n", "dockerfile")).toEqual([]);
    expect(ids(envNamePresenceInText("ARG OPENAI_API_KEY\r\n", "dockerfile"))).toEqual(["env.openai.api-key"]);
  });

  it("ci_yaml needs `:` or `=` after a bare name", () => {
    expect(envNamePresenceInText("OPENAI_API_KEY\n", "ci_yaml")).toEqual([]);
    expect(envNamePresenceInText("- OPENAI_API_KEY\n", "ci_yaml")).toEqual([]);
    expect(envNamePresenceInText("  OPENAI_API_KEY value\n", "ci_yaml")).toEqual([]);
    expect(ids(envNamePresenceInText("- OPENAI_API_KEY=x\n", "ci_yaml"))).toEqual(["env.openai.api-key"]);
  });

  it("matches within its own kind only", () => {
    const mixed: PresenceSignature[] = [
      good,
      { id: "cli.acme.tool", provider: "acme-ai", kind: "cli", value: "acme_ai_key", confidence: "medium", toolId: "acme", provenance: "admin" },
    ];
    expect(ids(matchEnvNames(["ACME_AI_KEY"], mixed))).toEqual(["env.acme.key"]);
    expect(ids(matchCliNames(["ACME_AI_KEY"], mixed))).toEqual(["cli.acme.tool"]);
    expect(ids(envNamePresenceInText("acme_ai_key=1\nACME_AI_KEY=1\n", "dotenv", mixed))).toEqual(["env.acme.key"]);
  });
});
