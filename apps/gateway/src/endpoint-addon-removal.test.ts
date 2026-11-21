/**
 * ADR-0331 §4 — the directive payload is a wire contract the Go agent strict-decodes. The golden payload the agent's
 * own test verifies (agents/endpoint/internal/contract/testdata/directive-payload.json) must be exactly the bytes the
 * gateway signs for the same values. No database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENDPOINT_ADDON_REMOVAL_STATUSES, ENDPOINT_ADDON_TARGET_STATUSES, ENDPOINT_DIRECTIVE_OUTCOME_CODES } from "@regulait/db";
import { ENDPOINT_ADDON_REMOVAL_MACHINE, ENDPOINT_ADDON_TARGET_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { directivePayload, outcomeCodeValid, removalArgumentsDigest, type ResolvedTarget } from "./endpoint-addon-removal.js";

const GOLDEN = fileURLToPath(new URL("../../../agents/endpoint/internal/contract/testdata/directive-payload.json", import.meta.url));

const values = {
  directiveId: "0f8e6a52-3c4b-4d1e-8f2a-6b7c9d0e1f2a",
  removalId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  identityId: "5b0c7a3e-2f1d-4c8b-9a6e-0d4f3b2a1c9e",
  issuedAt: new Date("2026-11-15T11:00:00Z"),
  notAfter: new Date("2026-11-22T11:00:00Z"),
  signatureId: "cursor-mcp",
  root: "home",
  path: ".cursor/mcp.json",
  serverName: "shadow",
  identityKind: "package",
  identity: "@evil/shadow-mcp",
  packageVersion: "2.1.0",
};

describe("ADR-0331: the directive payload", () => {
  it("is byte for byte the agent's golden payload", () => {
    expect(JSON.stringify(directivePayload(values))).toBe(readFileSync(GOLDEN, "utf8").trim());
  });

  it("truncates times to whole seconds and omits packageVersion when the removal names none", () => {
    const p = directivePayload({ ...values, issuedAt: new Date("2026-11-15T11:00:00.987Z"), packageVersion: null });
    expect(p.issuedAt).toBe("2026-11-15T11:00:00Z");
    expect(Object.keys(p.asset)).toEqual(["signatureId", "root", "path", "serverName", "identityKind", "identity"]);
  });

  it("each outcome carries only its own codes (ADR-0331 §7)", () => {
    expect(outcomeCodeValid("removed", "removed")).toBe(true);
    expect(outcomeCodeValid("nothing_to_remove", "identity_differs")).toBe(true);
    expect(outcomeCodeValid("failed", "removed")).toBe(false);
    expect(outcomeCodeValid("removed", "not_present")).toBe(false);
  });
});

// Owner rule 12 and ADR-0348: both lifecycles are declared machines in the one registry; these pin their shape so a
// later edit cannot open a path the ADR forbids (a final outcome rewritten, an undelivered target reported, a delivered
// target cancelled so its real outcome is lost, an unapproved removal delivered).
describe("ADR-0331: the removal and target lifecycles (ADR-0348 machines)", () => {
  it("are registered, and the column enums are the machines' states", () => {
    expect(STATE_MACHINES.endpoint_addon_removal).toBe(ENDPOINT_ADDON_REMOVAL_MACHINE);
    expect(STATE_MACHINES.endpoint_addon_target).toBe(ENDPOINT_ADDON_TARGET_MACHINE);
    expect([...ENDPOINT_ADDON_TARGET_MACHINE.def.states]).toEqual([...ENDPOINT_ADDON_TARGET_STATUSES]);
    expect([...ENDPOINT_ADDON_REMOVAL_MACHINE.def.states]).toEqual([...ENDPOINT_ADDON_REMOVAL_STATUSES]);
  });
  it("a target: delivered only from pending, an outcome only from delivered, cancel only before delivery", () => {
    const m = ENDPOINT_ADDON_TARGET_MACHINE;
    expect(m.sourcesOf("deliver")).toEqual(["pending"]);
    for (const e of ["report_removed", "report_nothing", "report_failed"] as const) expect(m.sourcesOf(e)).toEqual(["delivered"]);
    expect(m.sourcesOf("cancel")).toEqual(["pending"]);
    expect([...m.def.terminal].sort()).toEqual([...(Object.keys(ENDPOINT_DIRECTIVE_OUTCOME_CODES) as string[]), "cancelled"].sort());
  });
  it("a removal: sent only once approved; denied, stale and cancelled are final", () => {
    const m = ENDPOINT_ADDON_REMOVAL_MACHINE;
    expect(m.def.initial).toEqual(["awaiting_approval"]);
    expect(m.sourcesOf("approve")).toEqual(["awaiting_approval"]);
    expect(m.sourcesOf("go_stale")).toEqual(["awaiting_approval"]);
    expect([...m.sourcesOf("cancel")].sort()).toEqual(["active", "awaiting_approval"]);
    expect([...m.def.terminal].sort()).toEqual(["cancelled", "denied", "stale"]);
  });
});

describe("ADR-0331: the approval's arguments digest", () => {
  const facts = { identityKind: "package", identity: "@evil/x", packageVersion: null, serverName: null, scope: { kind: "recent", days: 7 }, blockReinstall: true, reason: "r" };
  const t = (path: string): ResolvedTarget => ({ deviceId: "d", identityId: "i", signatureId: "s", provider: "p", configRoot: "home", configPath: path, serverName: "x" });
  it("binds the request and the exact target set, in any order", () => {
    const one = removalArgumentsDigest(facts, [t("a.json"), t("b.json")]);
    expect(removalArgumentsDigest(facts, [t("b.json"), t("a.json")])).toBe(one);
    expect(removalArgumentsDigest(facts, [t("a.json")])).not.toBe(one);
    expect(removalArgumentsDigest(facts, [t("a.json"), t("c.json")])).not.toBe(one);
    expect(removalArgumentsDigest({ ...facts, reason: "other" }, [t("a.json"), t("b.json")])).not.toBe(one);
  });
});
