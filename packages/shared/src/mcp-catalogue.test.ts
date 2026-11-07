import { describe, expect, it } from "vitest";
import {
  bundleEntriesUsable,
  catalogueDedupeKey,
  githubRepoKey,
  MCP_CATALOGUE_PRESETS,
  mcpCatalogueBundleSchema,
  parseCommunityList,
  vettingFor,
} from "./mcp-catalogue.js";
import { normalizeRegistryPage, paidSignalFor } from "./mcp-registry.js";

// three lines in the exact shape of punkpeye/awesome-mcp-servers (README, 2026-11-07), plus noise
const LIST = [
  "# Awesome MCP Servers",
  "* 🎖️ – official implementation",
  "- [inth3shadows/terse](https://github.com/inth3shadows/terse) [![badge](https://glama.ai/x/badges/score.svg)](https://glama.ai/x) 🐍 🏠 - Transparent proxy that shrinks tool output.",
  "- [402signalhq/402signal](https://github.com/402signalhq/402signal) 🐍 ☁️ - Checks and validates live x402 payment routes.",
  "- [Acme/Weather.git](https://github.com/Acme/Weather.git) 📇 ☁️ - Forecasts; a paid plan unlocks history.",
  "- [dup](https://github.com/inth3shadows/terse/tree/main) - the same repository again",
  "- [elsewhere](https://gitlab.com/a/b) - not a GitHub repository",
  "- [broken](https://github.com/only-owner) - no repository segment",
  "  - [nested](https://github.com/x/y) - nested bullets are not entries",
].join("\n");

describe("ADR-0256 community list parser", () => {
  const parsed = parseCommunityList(LIST);

  it("keeps top-level GitHub entries once each, and counts what it skipped", () => {
    expect(parsed.entries.map((e) => e.upstreamName)).toEqual([
      "github.com/inth3shadows/terse",
      "github.com/402signalhq/402signal",
      "github.com/acme/weather",
    ]);
    expect(parsed.skipped).toBe(2);
    expect(parsed.capped).toBe(false);
  });

  it("makes every entry catalogue-only: a list names a repository, never an endpoint", () => {
    for (const e of parsed.entries) {
      expect(e).toMatchObject({ kind: "catalogue_only", catalogueReason: "community_listing", remoteUrl: null, remoteTransport: null });
    }
    expect(parsed.entries[0]!.description).toBe("Transparent proxy that shrinks tool output.");
  });

  it("flags x402 and paid listings, and leaves the rest unflagged", () => {
    expect(parsed.entries.map((e) => e.paidSignal)).toEqual([null, "x402", "paid"]);
  });

  it("is linear on a hostile line (no backtracking regex on record input)", () => {
    const hostile = "- [" + "[".repeat(200_000) + "](" + "(".repeat(200_000);
    const t = Date.now();
    expect(parseCommunityList(hostile).entries).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("ADR-0256 dedupe and vetting", () => {
  it("normalises GitHub repository urls and refuses everything else", () => {
    expect(githubRepoKey("https://github.com/Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(githubRepoKey("https://www.github.com/owner/repo/tree/main/x")).toBe("github.com/owner/repo");
    expect(githubRepoKey("https://gitlab.com/owner/repo")).toBeNull();
    expect(githubRepoKey("ftp://github.com/owner/repo")).toBeNull();
    expect(githubRepoKey("not a url")).toBeNull();
  });

  it("groups by repository first, then by name", () => {
    expect(catalogueDedupeKey({ upstreamName: "io.github.acme/weather", repositoryUrl: "https://github.com/acme/weather" })).toBe(
      "repo:github.com/acme/weather",
    );
    expect(catalogueDedupeKey({ upstreamName: "github.com/acme/weather", repositoryUrl: "https://github.com/acme/weather" })).toBe(
      "repo:github.com/acme/weather",
    );
    expect(catalogueDedupeKey({ upstreamName: "IO.Example/Thing", repositoryUrl: null })).toBe("name:io.example/thing");
  });

  it("calls a community source unvetted and a registry source registry-listed, never admitted", () => {
    expect(vettingFor("community")).toBe("unvetted");
    expect(vettingFor("registry")).toBe("registry_listed");
  });

  it("records the presets with the licences checked for ADR-0256", () => {
    expect(MCP_CATALOGUE_PRESETS.official).toMatchObject({ url: "https://registry.modelcontextprotocol.io", dataLicence: "CC0-1.0", listingKind: "registry" });
    expect(MCP_CATALOGUE_PRESETS["awesome-mcp-servers"]).toMatchObject({ dataLicence: "MIT", listingKind: "community" });
  });
});

describe("ADR-0256 paid signal on registry entries", () => {
  it("flags an x402 server from the official registry's own shape", () => {
    const page = normalizeRegistryPage({
      servers: [
        {
          server: {
            name: "ai.example/x402-services",
            description: "77 pay-per-call x402 tools",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://x.example/mcp" }],
          },
          _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
        },
        { server: { name: "io.example/free", description: "Weather forecasts", version: "1.0.0" } },
      ],
    });
    expect(page.entries.map((e) => e.paidSignal)).toEqual(["x402", null]);
  });

  it("does not read 'unpaid' as paid", () => {
    expect(paidSignalFor({ texts: [], describing: ["tracks unpaid invoices"] })).toBeNull();
    expect(paidSignalFor({ texts: [], describing: ["Pricing: per seat"] })).toBe("paid");
  });
});

describe("ADR-0256 offline bundle format", () => {
  const entry = {
    upstreamName: "io.example/remote",
    upstreamVersion: "1.0.0",
    title: null,
    description: null,
    repositoryUrl: null,
    websiteUrl: null,
    kind: "remote" as const,
    remoteUrl: "https://mcp.example/mcp",
    remoteTransport: "streamable-http" as const,
    catalogueReason: null,
    upstreamStatus: "active" as const,
    publishedAt: null,
    updatedAt: null,
    packageCount: 0,
    remoteCount: 1,
    paidSignal: null,
  };
  const bundle = {
    format: "regulait.mcp-catalogue-bundle/v1",
    createdAt: "2026-11-07T00:00:00Z",
    source: { name: "official-mcp-registry", listingKind: "registry", origin: "https://registry.modelcontextprotocol.io", dataLicence: "CC0-1.0" },
    truncated: false,
    entries: [entry],
  };

  it("parses strictly: an unknown field is refused", () => {
    expect(mcpCatalogueBundleSchema.safeParse(bundle).success).toBe(true);
    expect(mcpCatalogueBundleSchema.safeParse({ ...bundle, extra: 1 }).success).toBe(false);
    expect(mcpCatalogueBundleSchema.safeParse({ ...bundle, entries: [{ ...entry, trusted: true }] }).success).toBe(false);
  });

  it("drops a remote entry with an undialable url and a catalogue-only entry that claims an endpoint", () => {
    const out = bundleEntriesUsable([
      entry,
      { ...entry, upstreamName: "io.example/templated", remoteUrl: "https://{region}.example/mcp" },
      { ...entry, upstreamName: "io.example/liar", kind: "catalogue_only", catalogueReason: "packages_only" },
    ]);
    expect(out.entries.map((e) => e.upstreamName)).toEqual(["io.example/remote"]);
    expect(out.skipped).toBe(2);
  });
});
