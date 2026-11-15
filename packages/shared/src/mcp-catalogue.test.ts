import { describe, expect, it } from "vitest";
import {
  bundleEntriesUsable,
  catalogueDedupeKey,
  githubRepoKey,
  githubRepoLocation,
  MCP_CATALOGUE_DEDUPE_KEY_MAX,
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
  "- [mcp/fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) - Fetches web pages.",
  "- [mcp/git](https://github.com/modelcontextprotocol/servers/tree/main/src/git) - Reads git repositories.",
  "- [mcp/fetch again](https://github.com/ModelContextProtocol/servers/tree/main/src/fetch/) - listed twice",
  `- [huge](https://github.com/acme/${"r".repeat(500)}) - a repository name GitHub would not allow`,
  `- [long owner](https://github.com/${"o".repeat(40)}/x) - an owner GitHub would not allow`,
  `- [deep](https://github.com/acme/mono/tree/main/${"d/".repeat(150)}x) - a folder past the key bound`,
  "- [elsewhere](https://gitlab.com/a/b) - not a GitHub repository",
  "- [broken](https://github.com/only-owner) - no repository segment",
  "  - [nested](https://github.com/x/y) - nested bullets are not entries",
].join("\n");

describe("ADR-0256 community list parser", () => {
  const parsed = parseCommunityList(LIST);

  it("keeps top-level GitHub entries once each, and counts what it skipped, repeats included", () => {
    expect(parsed.entries.map((e) => e.upstreamName)).toEqual([
      "github.com/inth3shadows/terse",
      "github.com/402signalhq/402signal",
      "github.com/acme/weather",
      "github.com/modelcontextprotocol/servers/src/fetch",
      "github.com/modelcontextprotocol/servers/src/git",
    ]);
    // gitlab, owner-only, the terse repeat, the fetch repeat and the three oversized links
    expect(parsed.skipped).toBe(7);
    expect(parsed.capped).toBe(false);
  });

  it("never produces a key past the column bounds, whatever a line holds", () => {
    for (const e of parsed.entries) expect(catalogueDedupeKey(e).length).toBeLessThanOrEqual(MCP_CATALOGUE_DEDUPE_KEY_MAX);
    expect(githubRepoLocation(`https://github.com/acme/${"r".repeat(101)}`)).toBeNull();
    expect(githubRepoLocation(`https://github.com/acme/${"r".repeat(100)}`)).not.toBeNull();
    expect(githubRepoLocation(`https://github.com/acme/mono/tree/main/${"d".repeat(201)}`)).toBeNull();
  });

  it("keeps two servers from one monorepo apart, with the repository url rebuilt from the key", () => {
    const fetch = parsed.entries.find((e) => e.upstreamName.endsWith("/src/fetch"))!;
    const git = parsed.entries.find((e) => e.upstreamName.endsWith("/src/git"))!;
    expect(fetch).toMatchObject({ repositoryUrl: "https://github.com/modelcontextprotocol/servers", repositorySubfolder: "src/fetch" });
    expect(git.repositorySubfolder).toBe("src/git");
    expect(catalogueDedupeKey(fetch)).not.toBe(catalogueDedupeKey(git));
  });

  it("makes every entry catalogue-only: a list names a repository, never an endpoint", () => {
    for (const e of parsed.entries) {
      expect(e).toMatchObject({ kind: "catalogue_only", catalogueReason: "community_listing", remoteUrl: null, remoteTransport: null });
    }
    expect(parsed.entries[0]!.description).toBe("Transparent proxy that shrinks tool output.");
  });

  it("flags x402 and paid listings, and leaves the rest unflagged", () => {
    expect(parsed.entries.map((e) => e.paidSignal)).toEqual([null, "x402", "paid", null, null]);
  });

});

describe("ADR-0256 dedupe and vetting", () => {
  it("normalises GitHub repository urls and refuses everything else", () => {
    expect(githubRepoKey("https://github.com/Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(githubRepoKey("https://www.github.com/owner/repo/tree/main/x")).toBe("github.com/owner/repo");
    expect(githubRepoLocation("https://github.com/Owner/Repo/tree/main/src/Weather/")).toEqual({ repo: "github.com/owner/repo", subfolder: "src/weather" });
    expect(githubRepoLocation("https://github.com/owner/repo/tree/main")).toEqual({ repo: "github.com/owner/repo", subfolder: null });
    expect(githubRepoLocation("https://github.com/owner/repo/issues/1")).toEqual({ repo: "github.com/owner/repo", subfolder: null });
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

  it("keys a monorepo server by its subfolder, so the registry and a community list agree and siblings never merge", () => {
    const page = normalizeRegistryPage({
      servers: [
        { server: { name: "io.github.mcp/fetch", version: "1.0.0", repository: { url: "https://github.com/modelcontextprotocol/servers", subfolder: "./src/fetch/" } } },
        { server: { name: "io.github.mcp/git", version: "1.0.0", repository: { url: "https://github.com/modelcontextprotocol/servers", subfolder: "src/git" } } },
      ],
    });
    const [fetch, git] = page.entries;
    expect(fetch!.repositorySubfolder).toBe("src/fetch");
    expect(catalogueDedupeKey(fetch!)).toBe("repo:github.com/modelcontextprotocol/servers/src/fetch");
    expect(catalogueDedupeKey(git!)).toBe("repo:github.com/modelcontextprotocol/servers/src/git");
    // a registry subfolder too long to key on drops the repository: the entry is keyed by name, never merged
    const odd = normalizeRegistryPage({
      servers: [{ server: { name: "io.github.mcp/odd", version: "1", repository: { url: "https://github.com/modelcontextprotocol/servers", subfolder: "x".repeat(300) } } }],
    }).entries[0]!;
    expect(odd).toMatchObject({ repositoryUrl: null, repositorySubfolder: null });
    expect(catalogueDedupeKey(odd)).toBe("name:io.github.mcp/odd");
    // the community listing of the same folder lands on the same item
    const listed = parseCommunityList("- [fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) - x").entries[0]!;
    expect(catalogueDedupeKey(listed)).toBe(catalogueDedupeKey(fetch!));
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
    repositorySubfolder: null,
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
    ], "registry");
    expect(out.entries.map((e) => e.upstreamName)).toEqual(["io.example/remote"]);
    expect(out.skipped).toBe(2);
  });

  it("keeps a community bundle catalogue-only: an endpoint in one is dropped", () => {
    const listed = { ...entry, upstreamName: "github.com/a/b", kind: "catalogue_only" as const, remoteUrl: null, remoteTransport: null, catalogueReason: "community_listing" as const, remoteCount: 0 };
    const out = bundleEntriesUsable([entry, listed, { ...listed, catalogueReason: "packages_only" as const }], "community");
    expect(out.entries.map((e) => e.upstreamName)).toEqual(["github.com/a/b"]);
    expect(out.skipped).toBe(2);
  });
});
