import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PATRONAI_SOURCE, SHADOW_AI_CATALOG_V2, matchCatalogV2Endpoint, shadowCatalogV2EntrySchema } from "./shadow-catalog-v2.js";
import { SHADOW_AI_CATALOG_V3, SHADOW_AI_CATALOG_V3_VERSION } from "./shadow-catalog-v3.js";

const additions = SHADOW_AI_CATALOG_V3.slice(SHADOW_AI_CATALOG_V2.length);

describe("SHADOW_AI_CATALOG_V3 (ADR-0195 decision 15; L10)", () => {
  it("pins version, entry count and content hash — v3 can never drift silently", () => {
    expect(SHADOW_AI_CATALOG_V3_VERSION).toBe(3);
    expect(SHADOW_AI_CATALOG_V3).toHaveLength(205);
    const hash = createHash("sha256").update(JSON.stringify(SHADOW_AI_CATALOG_V3)).digest("hex");
    expect(hash).toBe("192fa285d884be58cdd2ac7ed1e0161a825f0964565f909582c4a165ec5a50b4");
    expect(Object.isFrozen(SHADOW_AI_CATALOG_V3)).toBe(true);
    expect(Object.isFrozen(additions[0])).toBe(true);
  });

  it("starts with every v2 entry, unchanged and in order", () => {
    SHADOW_AI_CATALOG_V2.forEach((v2, i) => expect(SHADOW_AI_CATALOG_V3[i]).toEqual(v2));
  });

  it("every entry passes the schema; ids and endpoint patterns are unique", () => {
    for (const e of SHADOW_AI_CATALOG_V3) expect(shadowCatalogV2EntrySchema.safeParse(e).success, e.id).toBe(true);
    const ids = SHADOW_AI_CATALOG_V3.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const eps = SHADOW_AI_CATALOG_V3.filter((e) => e.kind === "endpoint").map((e) => e.pattern.toLowerCase());
    expect(new Set(eps).size).toBe(eps.length);
  });

  it("every addition is an endpoint verified at the vendor; PatronAI-derived ones carry the pinned commit", () => {
    for (const e of additions) {
      expect(e.kind, e.id).toBe("endpoint");
      expect(e.verified?.url.startsWith("https://"), e.id).toBe(true);
      expect(e.verified?.checkedOn, e.id).toBe("2026-11-14");
      if (e.source.project === PATRONAI_SOURCE.project) {
        expect(e.source.commit).toBe(PATRONAI_SOURCE.commit);
        expect(e.source.licence).toBe("Apache-2.0");
      }
    }
  });

  it("matches the additions, most specific first, at dot boundaries only", () => {
    const m = (h: string) => matchCatalogV2Endpoint(h, SHADOW_AI_CATALOG_V3)?.id ?? null;
    expect(m("api.ai21.com")).toBe("ep-ai21-api");
    expect(m("my-app--serve.modal.run")).toBe("ep-modal-web");
    expect(m("modal.run.evil.test")).toBeNull();
    expect(m("api.v0.dev")).toBe("ep-v0-api");
    expect(m("acme.app.n8n.cloud")).toBe("ep-n8n-cloud");
    expect(m("www.sim.ai")).toBe("ep-sim-ai");
    expect(m("notsim.ai")).toBeNull();
    expect(m("index-1.svc.us-east1.pinecone.io")).toBeNull();
    expect(m("production-copilot-host-westus3.webpubsub.azure.com")).toBe("ep-github-copilot-cloud-session");
    expect(m("other.webpubsub.azure.com")).toBeNull();
    // v2 results are unchanged
    expect(m("api.business.githubcopilot.com")).toBe("ep-github-copilot-api");
    expect(m("api.x.ai")).toBe(matchCatalogV2Endpoint("api.x.ai")?.id);
  });

  it("generic hosting platforms are not AI signals and stay out", () => {
    for (const h of ["x.vercel.app", "x.onrender.com", "x.up.railway.app", "x.fly.dev"]) {
      expect(matchCatalogV2Endpoint(h, SHADOW_AI_CATALOG_V3), h).toBeNull();
    }
  });
});
