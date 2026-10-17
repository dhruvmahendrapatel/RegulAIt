import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENDPOINT_EVIDENCE_DEFAULT_RETENTION_DAYS,
  ENDPOINT_IMPORT_MAX_CELL,
  ENDPOINT_IMPORT_MAX_ROWS,
  ENDPOINT_PACK_FILE,
  ENDPOINT_PACK_QUERIES,
  ENDPOINT_REGISTRY_SOURCE_COMMIT,
  ENDPOINT_SIGNATURE_SEED,
  EndpointImportFormatError,
  EndpointPseudonymError,
  buildEndpointPackManifest,
  buildEndpointPackQueries,
  endpointSignatureSeedSchema,
  importEndpointInventory,
  importOsqueryResults,
  matchEndpointObservation,
  pseudonymisePath,
  renderEndpointPackManifest,
  resolveOsqueryResultName,
  signEndpointPackManifest,
  verifyEndpointPack,
  endpointArtifactCandidates,
  endpointCatalogueSignatures,
  isShippedEndpointProvenance,
  reduceEndpointObservations,
  type EndpointImportResult,
  type EndpointPseudonymHook,
} from "./index.js";
import { catalogueSignatureSchema, type AiSignature } from "../shadow-ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const vendorDir = path.join(here, "vendor", "ai-tool-registry");

/** a per-run HMAC hook, key derived at runtime (no secret-shaped literal) */
function testHook(): EndpointPseudonymHook {
  const key = randomBytes(32);
  return ({ kind, value }) => `p_${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
}

const identity = (r: EndpointImportResult) => r.observations.length + r.refusals.length + r.removedRows === r.rowsParsed;

describe("vendored AI tool registry (ADR-0176 provenance)", () => {
  const prov = JSON.parse(readFileSync(path.join(vendorDir, "PROVENANCE.json"), "utf8"));

  it("pins the commit the generated seed was built from, and every vendored file's digest", () => {
    expect(prov.commit).toBe(ENDPOINT_REGISTRY_SOURCE_COMMIT);
    expect(prov.licence).toBe("Apache-2.0");
    expect(prov.files.map((f: { path: string }) => f.path).sort()).toEqual(["LICENSE", "NOTICE", "TRADEMARKS.md", "registry/registry.yaml"]);
    for (const f of prov.files as Array<{ path: string; sha256: string }>) {
      expect(createHash("sha256").update(readFileSync(path.join(vendorDir, f.path))).digest("hex"), f.path).toBe(f.sha256);
    }
  });

  it("keeps the upstream NOTICE and is listed in THIRD_PARTY.md", () => {
    expect(readFileSync(path.join(vendorDir, "NOTICE"), "utf8")).toContain("Copyright 2026 Aman Karir");
    const tp = readFileSync(path.join(here, "..", "..", "THIRD_PARTY.md"), "utf8");
    expect(tp).toContain(ENDPOINT_REGISTRY_SOURCE_COMMIT);
  });
});

describe("endpoint signature seed", () => {
  it("validates, has unique ids, and pins its size", () => {
    for (const s of ENDPOINT_SIGNATURE_SEED) {
      const r = endpointSignatureSeedSchema.safeParse(s);
      expect(r.success, `${s.id}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
    expect(new Set(ENDPOINT_SIGNATURE_SEED.map((s) => s.id)).size).toBe(ENDPOINT_SIGNATURE_SEED.length);
    expect(ENDPOINT_SIGNATURE_SEED.filter((s) => s.source.origin === "third_party")).toHaveLength(90);
    expect(ENDPOINT_SIGNATURE_SEED.filter((s) => s.source.origin === "regulait")).toHaveLength(12);
  });

  it("records source, commit and licence on every imported row", () => {
    for (const s of ENDPOINT_SIGNATURE_SEED.filter((x) => x.source.origin === "third_party")) {
      if (s.source.origin !== "third_party") continue;
      expect(s.source.commit).toBe(ENDPOINT_REGISTRY_SOURCE_COMMIT);
      expect(s.source.licence).toBe("Apache-2.0");
      expect(s.provenance).toContain(ENDPOINT_REGISTRY_SOURCE_COMMIT);
    }
  });

  it("never uses the upstream project's name in a row (trademark policy)", () => {
    for (const s of ENDPOINT_SIGNATURE_SEED) {
      for (const field of [s.id, s.provider, s.tool, s.value, s.note ?? ""]) {
        expect(field.toLowerCase().includes("shadow ai guard"), s.id).toBe(false);
        expect(field.toLowerCase().includes("shadow-ai-guard"), s.id).toBe(false);
      }
    }
  });

  it("carries the hidden-assistant trait rows we wrote", () => {
    const traits = ENDPOINT_SIGNATURE_SEED.filter((s) => s.matchType === "trait_set");
    expect(traits.map((t) => t.value).sort()).toEqual([
      "background_agent+user_writable_path",
      "hidden_path+listen_all_interfaces",
      "listen_all_interfaces+user_writable_path",
    ]);
    expect(traits.every((t) => t.source.origin === "regulait")).toBe(true);
    // coordinator decision 2026-10-17: the LAN-listener rows stay on, marked low confidence
    const lan = traits.filter((t) => t.value.includes("listen_all_interfaces"));
    expect(lan.every((t) => t.enabled && t.confidence === "low")).toBe(true);
    expect(endpointSignatureSeedSchema.safeParse({ ...lan[0]!, value: "listen_all_interfaces+hidden_path" }).success).toBe(false);
  });

  it("refuses a trait name outside the closed vocabulary and an ecosystem on a non-extension row", () => {
    const base = ENDPOINT_SIGNATURE_SEED.find((s) => s.matchType === "trait_set")!;
    expect(endpointSignatureSeedSchema.safeParse({ ...base, value: "listen_all_interfaces+keylogger" }).success).toBe(false);
    expect(endpointSignatureSeedSchema.safeParse({ ...base, ecosystem: "chrome" }).success).toBe(false);
    expect(endpointSignatureSeedSchema.safeParse({ ...base, matchType: "app_name", value: "x' OR 1=1" }).success).toBe(false);
  });

  it("matches exact values case-insensitively, honours OS and the chromium ecosystem", () => {
    const hits = matchEndpointObservation(
      { os: "darwin", keys: [{ matchType: "bundle_id", value: "COM.ANTHROPIC.CLAUDEFORDESKTOP" }], traits: [] },
      ENDPOINT_SIGNATURE_SEED,
    );
    expect(hits.map((h) => h.tool)).toEqual(["claude"]);
    expect(matchEndpointObservation({ os: "windows", keys: [{ matchType: "app_name", value: "Claude.app" }], traits: [] }, ENDPOINT_SIGNATURE_SEED)).toEqual([]);
    const ext = matchEndpointObservation(
      { os: null, keys: [{ matchType: "browser_extension_id", value: "kbfnbcaeplbcioakkpcpgfkobkghlhen", ecosystem: "edge" }], traits: [] },
      ENDPOINT_SIGNATURE_SEED,
    );
    expect(ext.length).toBeGreaterThan(0);
    // a disabled row never matches
    const notion = ENDPOINT_SIGNATURE_SEED.filter((s) => s.tool === "notion-ai");
    expect(notion.length).toBeGreaterThan(0);
    expect(notion.every((s) => !s.enabled)).toBe(true);
    expect(matchEndpointObservation({ os: "darwin", keys: [{ matchType: "bundle_id", value: "notion.id" }], traits: [] }, ENDPOINT_SIGNATURE_SEED)).toEqual([]);
  });

  it("exports the 90-day endpoint retention default", () => {
    expect(ENDPOINT_EVIDENCE_DEFAULT_RETENTION_DAYS).toBe(90);
  });
});

describe("osquery query pack", () => {
  const packPath = path.join(repoRoot, "endpoint-discovery", "osquery", ENDPOINT_PACK_FILE);
  const manifestPath = path.join(repoRoot, "endpoint-discovery", "osquery", "manifest.json");

  it("the committed pack and manifest are exactly what the seed generates (run scripts/endpoint-pack-build.mjs)", () => {
    const { manifest, packText } = buildEndpointPackManifest();
    expect(readFileSync(packPath, "utf8")).toBe(packText);
    expect(readFileSync(manifestPath, "utf8")).toBe(renderEndpointPackManifest(manifest));
    expect(verifyEndpointPack(readFileSync(packPath, "utf8"), manifest)).toEqual({ digestOk: true, bytesOk: true, signed: false });
  });

  it("has osquery's pack shape", () => {
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    expect(Object.keys(pack)).toEqual(["queries"]);
    for (const [name, q] of Object.entries(pack.queries as Record<string, Record<string, unknown>>)) {
      expect(name.length).toBeGreaterThan(3);
      expect(typeof q.query).toBe("string");
      expect((q.query as string).startsWith("SELECT ")).toBe(true);
      expect((q.query as string).endsWith(";")).toBe(true);
      expect((q.query as string).slice(0, -1).includes(";")).toBe(false);
      expect(q.interval).toBe(86400);
      expect(q.snapshot).toBe(true);
      expect(q.removed).toBe(false);
      if (q.platform !== undefined) expect(["darwin", "windows", "linux", "posix"]).toContain(q.platform);
      expect(Object.keys(q).every((k) => ["query", "interval", "platform", "description", "snapshot", "removed"].includes(k))).toBe(true);
    }
  });

  it("uses only standard osquery tables, each named in its description", () => {
    const allowed = new Set([
      "apps", "programs", "deb_packages", "rpm_packages", "processes", "users", "vscode_extensions", "jetbrains_plugins",
      "chrome_extensions", "firefox_addons", "safari_extensions", "listening_ports", "npm_packages", "file", "process_envs", "registry",
    ]);
    for (const q of ENDPOINT_PACK_QUERIES) {
      for (const t of q.tables) {
        expect(allowed.has(t), `${q.name}: ${t}`).toBe(true);
        expect(q.sql!.includes(` ${t}`), `${q.name} reads ${t}`).toBe(true);
      }
    }
  });

  it("never selects a value, a command line or contents", () => {
    for (const q of ENDPOINT_PACK_QUERIES) {
      const select = q.sql!.slice(0, q.sql!.indexOf(" FROM ")).toLowerCase();
      for (const bad of ["cmdline", "value", " data", "environ", "hash", "sha256", "md5", "*"]) {
        expect(select.includes(bad), `${q.name} selects ${bad}`).toBe(false);
      }
      // every selected output column is one the importer allowlists
      for (const part of select.slice("select ".length).replace("distinct ", "").split(", ")) {
        const col = part.includes(" as ") ? part.slice(part.lastIndexOf(" as ") + 4) : part.trim();
        expect(Object.keys(q.columns), `${q.name}: ${col}`).toContain(col);
      }
    }
  });

  it("covers decision 18 on macOS, Windows and Linux", () => {
    const names = ENDPOINT_PACK_QUERIES.map((q) => q.name);
    for (const n of [
      "ai_apps_macos", "ai_programs_windows", "ai_deb_packages_linux", "ai_ide_extensions_vscode", "ai_browser_extensions_chromium",
      "ai_local_runtime_listeners", "ai_cli_npm_global", "ai_cli_binaries_macos", "ai_cli_binaries_windows", "ai_cli_binaries_linux",
      "ai_env_var_names_posix", "ai_env_var_names_windows", "ai_config_files_macos", "ai_config_files_windows", "ai_config_files_linux",
      "hidden_assistant_lan_listeners", "hidden_assistant_background_apps_macos",
    ]) expect(names).toContain(n);
  });

  it("leaves a query out when the seed gives it nothing to look for", () => {
    const qs = buildEndpointPackQueries(ENDPOINT_SIGNATURE_SEED.filter((s) => s.matchType !== "env_var_name"));
    expect(qs.find((q) => q.name === "ai_env_var_names_posix")!.sql).toBeNull();
  });
});

describe("pack manifest and signing hook", () => {
  it("is unsigned until SD4, and a signer only signs the digest it recomputes", async () => {
    const { manifest, packText } = buildEndpointPackManifest();
    expect(manifest.signature.status).toBe("unsigned");
    const signer = { sign: async (i: { sha256: string }) => ({ status: "signed" as const, scheme: "test", keyId: "k", value: `sig-${i.sha256.slice(0, 8)}` }) };
    const signed = await signEndpointPackManifest(packText, manifest, signer);
    expect(verifyEndpointPack(packText, signed).signed).toBe(true);
    await expect(signEndpointPackManifest(`${packText} `, manifest, signer)).rejects.toThrow(/does not match/);
    expect(verifyEndpointPack(`${packText} `, manifest).digestOk).toBe(false);
  });
});

describe("pseudonymisation", () => {
  it("refuses to import without a hook, or with a hook that echoes the clear value", () => {
    expect(() => importOsqueryResults({ content: "", pseudonymise: undefined as unknown as EndpointPseudonymHook })).toThrow(EndpointPseudonymError);
    const line = JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "alice-macbook", unixTime: 1790000000, columns: { name: "Claude.app" }, action: "added" });
    expect(() => importOsqueryResults({ content: line, pseudonymise: ({ value }) => value })).toThrow(EndpointPseudonymError);
  });

  it("rewrites the home segment of macOS, Linux and Windows paths", () => {
    const hook = testHook();
    const mac = pseudonymisePath("/Users/alice/.claude.json", hook);
    expect(mac.path).not.toContain("alice");
    expect(mac.homeRelative).toBe(".claude.json");
    const win = pseudonymisePath("C:\\Users\\bob\\AppData\\Roaming\\Claude\\claude_desktop_config.json", hook);
    expect(win.path).not.toContain("bob");
    expect(win.path.startsWith("C:\\Users\\p_")).toBe(true);
    expect(win.homeRelative).toBe("AppData/Roaming/Claude/claude_desktop_config.json");
    const lin = pseudonymisePath("/home/carol/.codex", hook);
    expect(lin.homeRelative).toBe(".codex");
    expect(mac.userPseudonym).not.toBe(lin.userPseudonym);
    expect(pseudonymisePath("/usr/local/bin/claude", hook)).toEqual({ path: "/usr/local/bin/claude", homeRelative: null, userPseudonym: null });
  });
});

describe("osquery results importer", () => {
  const hook = testHook();

  it("resolves pack-qualified result names with any delimiter", () => {
    expect(resolveOsqueryResultName("pack/regulait_ai_discovery/ai_apps_macos", "regulait_ai_discovery")).toBe("ai_apps_macos");
    expect(resolveOsqueryResultName("pack_regulait_ai_discovery_ai_apps_macos", "regulait_ai_discovery")).toBe("ai_apps_macos");
    expect(resolveOsqueryResultName("ai_apps_macos", "regulait_ai_discovery")).toBe("ai_apps_macos");
  });

  it("reads snapshot, event and batch records; counts removals; never keeps a username or host name in clear", () => {
    const content = [
      JSON.stringify({
        name: "pack/regulait_ai_discovery/ai_apps_macos",
        hostIdentifier: "alice-macbook",
        unixTime: 1790000000,
        action: "snapshot",
        decorations: { username: "alice" },
        snapshot: [
          { name: "Claude.app", bundle_identifier: "com.anthropic.claudefordesktop", bundle_short_version: "1.0", path: "/Applications/Claude.app", element: "0" },
          { name: "Hider.app", bundle_identifier: "org.example.hider", path: "/Users/alice/Applications/Hider.app", element: "1" },
        ],
      }),
      "",
      JSON.stringify({
        name: "pack/regulait_ai_discovery/ai_ide_extensions_vscode",
        hostIdentifier: "alice-macbook",
        unixTime: "1790000100",
        columns: { username: "alice", extension_id: "anthropic.claude-code", version: "2.0.0", vscode_edition: "vscode" },
        action: "added",
      }),
      JSON.stringify({
        name: "pack/regulait_ai_discovery/ai_config_files_linux",
        hostIdentifier: "build-07",
        diffResults: {
          added: [{ path: "/home/alice/.codex", type: "directory", mtime: "1790000000" }],
          removed: [{ path: "/home/alice/.gemini", type: "directory", mtime: "1" }],
        },
      }),
      JSON.stringify({ name: "pack/regulait_ai_discovery/ai_ide_extensions_vscode", hostIdentifier: "h", columns: { extension_id: "x.y" }, action: "removed" }),
    ].join("\n");
    const r = importOsqueryResults({ content, pseudonymise: hook });
    expect(r.refusals).toEqual([]);
    expect(r.rowsParsed).toBe(6);
    expect(r.removedRows).toBe(2);
    expect(r.observations).toHaveLength(4);
    expect(identity(r)).toBe(true);
    expect(r.devices).toBe(2);
    expect(r.rowsWithoutTimestamp).toBe(1);
    const dump = JSON.stringify(r);
    for (const clear of ["alice", "build-07"]) expect(dump.includes(clear), clear).toBe(false);

    const [claude, hider, ext, codex] = r.observations;
    expect(claude!.os).toBe("darwin");
    expect(matchEndpointObservation(claude!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["claude", "claude"]);
    expect(hider!.traits).toEqual(["background_agent", "user_writable_path"]);
    expect(matchEndpointObservation(hider!, ENDPOINT_SIGNATURE_SEED).map((s) => s.id)).toEqual(["rgl.hidden-assistant.trait_set.windowless-user-app"]);
    expect(endpointArtifactCandidates(hider!)).toContainEqual({ kind: "desktop_app", value: "trait:background_agent+user_writable_path", ecosystem: null, from: "trait_set" });
    expect(ext!.user).toMatch(/^p_/);
    expect(ext!.observedAt).toBe(new Date(1790000100 * 1000).toISOString());
    expect(matchEndpointObservation(ext!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["claude-code"]);
    expect(codex!.keys).toContainEqual({ matchType: "config_path", value: ".codex" });
    expect(matchEndpointObservation(codex!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["codex-cli"]);
    expect(codex!.user).toBe(ext!.user); // the same person on two devices keeps one pseudonym
  });

  it("detects a LAN-listening program from a hidden directory and a local runtime port", () => {
    const content = JSON.stringify({
      name: "hidden_assistant_lan_listeners",
      hostIdentifier: "dev-1",
      unixTime: 1790000000,
      snapshot: [
        { name: "helper", path: "/Users/dana/.cache/helper/helper", port: "47000", address: "0.0.0.0", protocol: "6" },
        { name: "node", path: "/usr/local/bin/node", port: "3000", address: "127.0.0.1", protocol: "6" },
      ],
    }) + "\n" + JSON.stringify({
      name: "ai_local_runtime_listeners",
      hostIdentifier: "dev-1",
      unixTime: 1790000000,
      snapshot: [{ name: "ollama", path: "/usr/local/bin/ollama", port: "11434", address: "127.0.0.1", protocol: "6" }],
    });
    const r = importOsqueryResults({ content, pseudonymise: hook });
    expect(identity(r)).toBe(true);
    const [helper, node, ollama] = r.observations;
    expect(helper!.traits).toEqual(["hidden_path", "listen_all_interfaces", "user_writable_path"]);
    expect(matchEndpointObservation(helper!, ENDPOINT_SIGNATURE_SEED).map((s) => s.id).sort()).toEqual([
      "rgl.hidden-assistant.trait_set.lan-listener-hidden-dir",
      "rgl.hidden-assistant.trait_set.lan-listener-user-dir",
    ]);
    expect(matchEndpointObservation(node!, ENDPOINT_SIGNATURE_SEED)).toEqual([]);
    expect(JSON.stringify(helper)).not.toContain("0.0.0.0");
    expect(new Set(matchEndpointObservation(ollama!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool))).toEqual(new Set(["ollama"]));
  });

  it("refuses, with line numbers, rows it will not import — and counts every one", () => {
    const content = [
      "not json",
      JSON.stringify({ name: "ai_apps_macos", unixTime: 1790000000, columns: { name: "Claude.app" } }),
      JSON.stringify({ name: "some_other_query", hostIdentifier: "h", columns: { name: "x" } }),
      JSON.stringify({ name: "ai_env_var_names_posix", hostIdentifier: "h", columns: { process_name: "zsh", key: "OPENAI_API_KEY", value: "synthetic" } }),
      JSON.stringify({ name: "ai_local_runtime_listeners", hostIdentifier: "h", columns: { name: "ollama", port: "99999" } }),
      JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "h", columns: { name: "", bundle_identifier: "" } }),
      JSON.stringify({ hello: "world" }),
      JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "h", columns: { name: { nested: true } } }),
    ].join("\n");
    const r = importOsqueryResults({ content, pseudonymise: hook });
    expect(r.observations).toEqual([]);
    expect(r.refusals.map((x) => x.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.refusals[3]!.field).toBe("value");
    expect(JSON.stringify(r)).not.toContain("synthetic");
    expect(identity(r)).toBe(true);
  });

  it("refuses an oversized file whole", () => {
    const line = JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "h", columns: { name: "Claude.app" } });
    const content = Array.from({ length: ENDPOINT_IMPORT_MAX_ROWS + 1 }, () => line).join("\n");
    expect(() => importOsqueryResults({ content, pseudonymise: hook })).toThrow(EndpointImportFormatError);
  });

  it("refuses an over-long line as one counted row", () => {
    const big = JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "h", snapshot: Array.from({ length: 20_000 }, () => ({ name: "Claude.app" })) });
    const r = importOsqueryResults({ content: big, pseudonymise: hook });
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.reason).toMatch(/over/);
    expect(identity(r)).toBe(true);
  });

  it("reads the same records given as one JSON array", () => {
    const content = JSON.stringify([{ name: "ai_cli_npm_global", hostIdentifier: "h", unixTime: 1790000000, columns: { name: "@openai/codex", version: "1.0.0", path: "/usr/local/lib/node_modules/@openai/codex" } }]);
    const r = importOsqueryResults({ content, pseudonymise: hook });
    expect(matchEndpointObservation(r.observations[0]!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["codex-cli"]);
  });
});

describe("generic MDM/EDR inventory importer", () => {
  const hook = testHook();

  it("infers a mapping, pseudonymises device and user, and matches against the seed", () => {
    const csv = ["Computer Name,Software,Bundle ID,Version,User,OS,Last Seen", "ALICE-MBP,Claude,com.anthropic.claudefordesktop,1.0,alice@example.test,macOS 15,2026-10-01T00:00:00Z", "BOB-PC,Cursor,,0.5,bob,Windows 11,"].join("\n");
    const r = importEndpointInventory({ content: csv, format: "csv", pseudonymise: hook });
    expect(r.refusals).toEqual([]);
    expect(r.observations).toHaveLength(2);
    expect(identity(r)).toBe(true);
    const dump = JSON.stringify(r);
    for (const clear of ["ALICE-MBP", "alice@example.test", "BOB-PC", "\"bob\""]) expect(dump.includes(clear), clear).toBe(false);
    const [a, b] = r.observations;
    expect(a!.os).toBe("darwin");
    expect(matchEndpointObservation(a!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["claude"]);
    expect(b!.os).toBe("windows");
    expect(matchEndpointObservation(b!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["cursor"]);
    expect(r.rowsWithoutTimestamp).toBe(1);
  });

  it("refuses an ambiguous required column rather than guess", () => {
    const csv = "hostname,device,software\nh1,d1,Claude";
    expect(() => importEndpointInventory({ content: csv, format: "csv", pseudonymise: hook })).toThrow(/ambiguous/);
  });

  it("applies an explicit mapping and item types; refuses unknown types and empty required cells with their line", () => {
    const json = JSON.stringify([
      { asset_tag: "D1", item: "anthropic.claude-code", t: "IDE Extension" },
      { asset_tag: "D2", item: "kbfnbcaeplbcioakkpcpgfkobkghlhen", t: "addon" },
      { asset_tag: "D3", item: "x", t: "firmware" },
      { asset_tag: "", item: "Claude", t: "app" },
    ]);
    const r = importEndpointInventory({
      content: json,
      format: "json",
      pseudonymise: hook,
      config: { mapping: { device: "asset_tag", itemName: "item", itemType: "t" }, itemTypeValues: { addon: "browser_extension" } },
    });
    expect(r.observations).toHaveLength(2);
    expect(r.refusals.map((x) => x.line)).toEqual([3, 4]);
    expect(identity(r)).toBe(true);
    expect(matchEndpointObservation(r.observations[0]!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool)).toEqual(["claude-code"]);
    expect(new Set(matchEndpointObservation(r.observations[1]!, ENDPOINT_SIGNATURE_SEED).map((s) => s.tool))).toEqual(new Set(["grammarly"]));
  });

  it("refuses a mapping to a value-bearing column, a mapping to a missing column, and a vendor-named preset key", () => {
    const csv = "device,name,value\nd,OPENAI_API_KEY,synthetic";
    expect(() =>
      importEndpointInventory({ content: csv, format: "csv", pseudonymise: hook, config: { mapping: { device: "device", itemName: "value" } } }),
    ).toThrow(/may not be mapped/);
    expect(() =>
      importEndpointInventory({ content: csv, format: "csv", pseudonymise: hook, config: { mapping: { device: "device", itemName: "nope" } } }),
    ).toThrow(/does not carry/);
    expect(() => importEndpointInventory({ content: csv, format: "csv", pseudonymise: hook, config: { preset: "any-vendor" } })).toThrow(EndpointImportFormatError);
  });
});

describe("SD0 catalogue bridge (phase B)", () => {
  const rows = endpointCatalogueSignatures();

  it("every seed row becomes a valid SD0 `identifier` catalogue row", () => {
    for (const r of rows) {
      const { seedIds: _s, ...sig } = r;
      const parsed = catalogueSignatureSchema.safeParse(sig);
      expect(parsed.success, `${r.kind} ${r.value}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
      expect(isShippedEndpointProvenance(r.provenance)).toBe(true);
    }
    expect(rows.reduce((n, r) => n + r.seedIds.length, 0)).toBe(ENDPOINT_SIGNATURE_SEED.length);
  });

  it("no (kind, identifier) collision crosses providers", () => {
    const byId = new Map<string, string>();
    for (const s of ENDPOINT_SIGNATURE_SEED) {
      const r = rows.find((x) => x.seedIds.includes(s.id))!;
      const k = `${r.kind}:${r.value.toLowerCase()}`;
      if (byId.has(k)) expect(byId.get(k), `${s.id} vs ${k}`).toBe(s.provider);
      byId.set(k, s.provider);
    }
  });

  it("encodes ports and trait sets, and keeps the low confidence on the LAN rows", () => {
    expect(rows.find((r) => r.value === "port:11434")?.kind).toBe("local_runtime");
    const lan = rows.filter((r) => r.value.startsWith("trait:") && r.value.includes("listen_all_interfaces"));
    expect(lan).toHaveLength(2);
    expect(lan.every((r) => r.confidence === "low" && r.enabled)).toBe(true);
    expect(rows.filter((r) => r.value.startsWith("trait:")).every((r) => r.provenance === "regulait-seed")).toBe(true);
    expect(isShippedEndpointProvenance("admin")).toBe(false);
    expect(rows.filter((r) => r.confidence !== "low").every((r) => r.confidence === "high")).toBe(true);
  });

  it("scopes rows by OS and ecosystem in SD0's vocabulary", () => {
    expect(rows.find((r) => r.value === "Claude.app")?.os).toBe("macos");
    expect(rows.find((r) => r.value === "claude.exe")?.os).toBe("windows");
    // a row SD3 scopes to two OSes is stored as any
    expect(rows.find((r) => r.kind === "desktop_app" && r.value.toLowerCase() === "claude")?.os).toBeNull();
    // Chrome and Edge share one id space
    const grammarly = rows.filter((r) => r.value === "kbfnbcaeplbcioakkpcpgfkobkghlhen");
    expect(grammarly).toHaveLength(1);
    expect(grammarly[0]!.ecosystem).toBe("chromium");
    expect(rows.find((r) => r.value === "anthropic.claude-code")?.ecosystem).toBe("vscode");
    expect(rows.find((r) => r.value === "anthropic.claude-code")?.toolId).toBe("claude-code");
  });

  it("reduces observations against the enabled catalogue only, one sighting per device and artifact", () => {
    const hook = testHook();
    const content = [
      JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "m1", unixTime: 1790000000, snapshot: [{ name: "Claude.app", bundle_identifier: "com.anthropic.claudefordesktop" }, { name: "Unknown.app", bundle_identifier: "org.example.unknown" }] }),
      JSON.stringify({ name: "ai_apps_macos", hostIdentifier: "m1", unixTime: 1790000500, columns: { name: "Claude.app" } }),
      JSON.stringify({ name: "hidden_assistant_lan_listeners", hostIdentifier: "m2", columns: { name: "h", path: "/Users/x/.h/h", port: "4000", address: "0.0.0.0" } }),
    ].join("\n");
    const imported = importOsqueryResults({ content, pseudonymise: hook });
    const catalogue: AiSignature[] = rows.map(({ seedIds: _s, ...sig }) => sig);
    const red = reduceEndpointObservations(imported, catalogue);
    const claude = red.matched.filter((m) => m.provider === "anthropic");
    expect(claude).toHaveLength(1);
    expect(claude[0]!.count).toBe(2);
    expect(claude[0]!.observedAt).toBe(new Date(1790000500 * 1000).toISOString());
    expect(red.matched.some((m) => m.value.startsWith("trait:") && m.provider === "unattributed")).toBe(true);
    expect(red.unmatchedCount).toBe(1);
    expect(red.unmatched[0]!.value).toBe("Unknown.app");
    // detection is data: with the catalogue empty or disabled nothing matches
    expect(reduceEndpointObservations(imported, []).matched).toEqual([]);
    // an OS-scoped row does not match a sighting from another OS
    const asWindows = { observations: imported.observations.map((o) => ({ ...o, os: "windows" as const })) };
    expect(reduceEndpointObservations(asWindows, catalogue).matched.some((m) => m.value === "Claude.app")).toBe(false);
    expect(claude[0]!.os).toBe("macos");
    expect(reduceEndpointObservations(imported, catalogue.map((c) => ({ ...c, enabled: false }))).matched).toEqual([]);
  });
});

describe("review fixes (#401)", () => {
  const hook = testHook();

  it("never resolves a prototype member from an item-type cell", () => {
    for (const t of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = importEndpointInventory({ content: `device,software,type\nlaptop-1,Cursor,${t}\n`, format: "csv", pseudonymise: hook });
      expect(r.observations, t).toEqual([]);
      expect(r.refusals.map((x) => x.line), t).toEqual([2]);
      expect(identity(r)).toBe(true);
    }
    // a configured word still works, including one an attacker might hope collides
    const ok = importEndpointInventory({
      content: "device,software,type\nlaptop-1,Cursor,constructor\n",
      format: "csv",
      pseudonymise: hook,
      config: { itemTypeValues: { constructor: "application" } },
    });
    expect(ok.observations).toHaveLength(1);
  });

  it("refuses rows that fill a value-bearing column, mapped or not, in both importers", () => {
    const inv = importEndpointInventory({ content: "device,software,cmd\nd1,Cursor,\nd2,Cursor,run --token=x\n", format: "csv", pseudonymise: hook });
    expect(inv.observations).toHaveLength(1);
    expect(inv.refusals).toEqual([expect.objectContaining({ line: 3, field: "cmd" })]);
    expect(JSON.stringify(inv)).not.toContain("--token");
    for (const col of ["commandline", "args", "argv", "environment_variables", "env_values"]) {
      const line = JSON.stringify({ name: "ai_running_processes", hostIdentifier: "h", columns: { name: "ollama", [col]: "synthetic" } });
      const r = importOsqueryResults({ content: line, pseudonymise: hook });
      expect(r.refusals.map((x) => x.field), col).toEqual([col]);
    }
  });

  it("refuses an environment variable 'name' that is not a name, and never records an env-var gap", () => {
    const line = JSON.stringify({
      name: "pack/regulait_ai_discovery/ai_env_var_names_posix",
      hostIdentifier: "h1",
      unixTime: 1790000000,
      action: "snapshot",
      snapshot: [
        { process_name: "node", key: "sk-live-SYNTHETIC123" },
        { process_name: "node", key: "SYNTHETICVALUE123" },
      ],
    });
    const r = importOsqueryResults({ content: line, pseudonymise: hook });
    expect(r.refusals).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("sk-live");
    const red = reduceEndpointObservations(r, endpointCatalogueSignatures().map(({ seedIds: _s, ...sig }) => sig));
    expect(red.unmatched.map((u) => u.value)).not.toContain("SYNTHETICVALUE123");
  });

  it("bounds a kept cell at SD0's 512-character value bound", () => {
    expect(ENDPOINT_IMPORT_MAX_CELL).toBe(512);
    const r = importEndpointInventory({ content: `device,software\nd1,${"x".repeat(513)}\n`, format: "csv", pseudonymise: hook });
    expect(r.refusals).toHaveLength(1);
  });
});

describe("credential-shaped values (SD0 scrubber parity)", () => {
  it("drops a candidate the audit scrubber would change, and never samples it as a gap", () => {
    const hook = testHook();
    // synthetic, built at runtime: a value shaped like a provider key (gitleaks-safe)
    const keyShaped = ["sk", "ant", "api03", "z".repeat(90)].join("-");
    const content = JSON.stringify({ name: "ai_running_processes", hostIdentifier: "h", columns: { name: keyShaped } });
    const r = importOsqueryResults({ content, pseudonymise: hook });
    const red = reduceEndpointObservations(r, endpointCatalogueSignatures().map(({ seedIds: _s, ...sig }) => sig));
    expect(red.credentialShapedDropped).toBeGreaterThan(0);
    expect(JSON.stringify(red)).not.toContain(keyShaped);
  });
});
