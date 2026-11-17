/**
 * ADR-0331 §4 — the directive payload is a wire contract the Go agent strict-decodes. The golden payload the agent's
 * own test verifies (agents/endpoint/internal/contract/testdata/directive-payload.json) must be exactly the bytes the
 * gateway signs for the same values. No database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ENDPOINT_ADDON_TARGET_OPEN_STATUSES,
  ENDPOINT_ADDON_TARGET_STATUSES,
  ENDPOINT_ADDON_TARGET_TRANSITIONS,
  ENDPOINT_DIRECTIVE_OUTCOME_CODES,
  endpointAddonTargetSources,
} from "@regulait/db";
import { directivePayload, outcomeCodeValid } from "./endpoint-addon-removal.js";

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

// Owner rule 12 (2026-11-17): the target lifecycle is one declared table; these pin its shape so a later edit cannot
// open a path the ADR forbids (a final outcome rewritten, an undelivered target reported, a cancelled one revived).
describe("ADR-0331: the removal target lifecycle", () => {
  it("declares every status, and only known statuses", () => {
    expect(Object.keys(ENDPOINT_ADDON_TARGET_TRANSITIONS).sort()).toEqual([...ENDPOINT_ADDON_TARGET_STATUSES].sort());
    for (const to of Object.values(ENDPOINT_ADDON_TARGET_TRANSITIONS).flat()) expect(ENDPOINT_ADDON_TARGET_STATUSES).toContain(to);
  });
  it("makes every outcome and cancelled final", () => {
    for (const s of [...(Object.keys(ENDPOINT_DIRECTIVE_OUTCOME_CODES) as (keyof typeof ENDPOINT_DIRECTIVE_OUTCOME_CODES)[]), "cancelled" as const]) {
      expect(ENDPOINT_ADDON_TARGET_TRANSITIONS[s]).toEqual([]);
    }
    expect(ENDPOINT_ADDON_TARGET_OPEN_STATUSES).toEqual(["pending", "delivered"]);
  });
  it("reaches an outcome only from delivered, delivery only from pending, and cancel from any open state", () => {
    for (const o of Object.keys(ENDPOINT_DIRECTIVE_OUTCOME_CODES) as (keyof typeof ENDPOINT_DIRECTIVE_OUTCOME_CODES)[]) {
      expect(endpointAddonTargetSources(o)).toEqual(["delivered"]);
    }
    expect(endpointAddonTargetSources("delivered")).toEqual(["pending"]);
    expect(endpointAddonTargetSources("cancelled")).toEqual(["pending", "delivered"]);
    expect(endpointAddonTargetSources("pending")).toEqual([]);
  });
});
