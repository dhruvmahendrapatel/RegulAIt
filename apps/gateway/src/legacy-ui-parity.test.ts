/**
 * THE PARITY GATE, AS A TEST.
 *
 * The two template-literal UIs (`admin-portal.ts`, `app-ui.ts`) are slated for
 * deletion. An earlier deletion attempt was REVERTED because "the SPA is at
 * parity" was asserted rather than evidenced, and a later audit found six
 * capabilities that really were still legacy-only. `scripts/parity-diff.mjs`
 * extracts, from source, what each UI can make the gateway do; this test runs
 * it so `pnpm -r test` fails the moment the SPA falls behind again — a claim
 * of parity is now something CI checks rather than something a human asserts.
 *
 * Needs no database, so it is cheap; it shells out rather than importing the
 * script because exit status IS the script's contract.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function runGate(): { status: number; out: string } {
  try {
    const out = execFileSync("node", [path.join(repoRoot, "scripts/parity-diff.mjs"), "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: err.stdout ?? err.stderr ?? "" };
  }
}

describe("legacy UI vs SPA capability parity", () => {
  const { status, out } = runGate();
  const report = JSON.parse(out) as {
    legacyEndpoints: string[];
    spaEndpoints: string[];
    legacyEventKinds: string[];
    spaEventKinds: string[];
    endpointGaps: string[];
    eventGaps: string[];
    bodyGaps: Array<{ endpoint: string; missing: string[] }>;
  };

  it("the SPA calls every endpoint shape the legacy UIs call", () => {
    expect(report.endpointGaps, "legacy-only endpoints").toEqual([]);
  });

  it("the SPA can POST every run event kind the legacy UI can", () => {
    // reassign_node and node_submitted were legacy-only until the operator
    // console landed; `kind:` is matched as a POSTED property, so merely
    // rendering an event in the run timeline never counts as driving it.
    expect(report.eventGaps, "legacy-only run event kinds").toEqual([]);
  });

  it("the SPA sends every request-body key the legacy UI sends on the run-driving endpoints", () => {
    // e.g. auto-advance's per-node `inputs` override map.
    expect(report.bodyGaps, "legacy-only request body keys").toEqual([]);
  });

  it("the extractor actually resolved both sides (a silent zero would fake parity)", () => {
    // A broken extractor reports parity by finding nothing at all. These floors
    // are the honest guard: both inventories must stay substantial.
    expect(report.legacyEndpoints.length).toBeGreaterThan(120);
    expect(report.spaEndpoints.length).toBeGreaterThan(120);
    expect(report.legacyEventKinds.length).toBeGreaterThanOrEqual(7);
    expect(report.spaEventKinds.length).toBeGreaterThanOrEqual(7);
  });

  it("exits non-zero only when a gap exists", () => {
    const gaps = report.endpointGaps.length + report.eventGaps.length + report.bodyGaps.length;
    expect(status).toBe(gaps === 0 ? 0 : 1);
  });
});
