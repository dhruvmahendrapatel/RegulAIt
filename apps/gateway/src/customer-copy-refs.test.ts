/**
 * #453 (owner, 2026-10-30): customer-visible copy names no internal reference. These are the strings the console
 * shows an admin verbatim; none of them may cite a decision record (`ADR-0067`) or a spec section (`§8.3`).
 * Comments, log lines, audit codes and API field names are out of scope and stay as they are.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_RECOMMENDATION_RULES_V1,
  FORECAST_DISCLAIMER,
  FORECAST_LIMITS,
  LICENSE_ACTION_INVENTORY,
} from "@regulait/shared";
import { alertSlaJobDefinitions } from "./alert-ownership.js";
import { EVAL_SCORERS_NOTE } from "./evals.js";
import { LICENSE_ENFORCEMENT_POINTS_WIRED } from "./licensing.js";
import { SPEND_ANOMALY_SWEEP_NOTE } from "./spend-monitor.js";
import { builtInShapes, complianceShapeDescription } from "./template-gallery.js";

const INTERNAL_REF = /ADR-\d{4}|§\d/;

const customerStrings: Array<[string, string]> = [
  ["evals scorers note", EVAL_SCORERS_NOTE],
  ["spend anomaly sweep note", SPEND_ANOMALY_SWEEP_NOTE],
  ["forecast disclaimer", FORECAST_DISCLAIMER],
  ...FORECAST_LIMITS.map((l): [string, string] => ["forecast limit", l]),
  ...alertSlaJobDefinitions().map((j): [string, string] => [`scheduler job ${j.name}`, j.description ?? ""]),
  ...builtInShapes().map((s): [string, string] => [`gallery ${s.galleryId}`, s.description ?? ""]),
  ["gallery compliance shape", complianceShapeDescription("hipaa")],
  ...ACCESS_RECOMMENDATION_RULES_V1.flatMap((r): Array<[string, string]> => [
    [`recommendation ${r.id} title`, r.title],
    [`recommendation ${r.id} rationale`, r.rationaleTemplate],
    [`recommendation ${r.id} limits`, r.limits],
  ]),
  ...LICENSE_ACTION_INVENTORY.map((a): [string, string] => [`licence action ${a.action}`, `${a.label} ${a.why}`]),
  ...LICENSE_ENFORCEMENT_POINTS_WIRED.map((p): [string, string] => ["licence enforcement point", p]),
];

describe("customer-visible copy", () => {
  it("cites no ADR number or spec section", () => {
    expect(customerStrings.filter(([, text]) => INTERNAL_REF.test(text)).map(([where]) => where)).toEqual([]);
  });

  it("names no table, column or environment variable in the rewritten strings", () => {
    const leaks = /usage_events|alert_sla_hours|REGULAIT_SCHEDULER|lastEvaluatedAt|requiredTemplateIdsFor|pillar[- ]\d|agent_retired/;
    expect(customerStrings.filter(([, text]) => leaks.test(text)).map(([where]) => where)).toEqual([]);
  });

  it("shows no raw action code as a licence action label or enforcement point", () => {
    const code = /\b[a-z_]+\.[a-z_]+\b/;
    expect(LICENSE_ACTION_INVENTORY.filter((a) => !a.label || code.test(a.label)).map((a) => a.action)).toEqual([]);
    expect(LICENSE_ENFORCEMENT_POINTS_WIRED.filter((p) => code.test(p))).toEqual([]);
  });

  it("labels the licence actions a customer reads by code", () => {
    const label = (action: string) => LICENSE_ACTION_INVENTORY.find((a) => a.action === action)?.label;
    expect(label("mcp_server.create")).toBe("Register an MCP server");
    expect(label("model_provider.connect")).toBe("Connect a model provider");
    expect(label("pm_connection.create")).toBe("Connect a project tracker");
  });
});
