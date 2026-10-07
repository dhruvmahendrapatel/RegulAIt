/**
 * ADR-0186 V — the agt-mcp-heuristics pack applied to an MCP tool manifest
 * (foundation). Separate from `./match.ts` so the guardrail and audit paths
 * never load the MCP scanner (which itself imports the guardrails).
 */
import type { McpAdmissionFinding, ScannableTool } from "../mcp-admission.js";
import { scanUnitsForTool } from "../mcp-admission.js";
import { VENDORED_MCP_HEURISTICS, type VendoredMcpHeuristic } from "./index.js";
import { vendoredPackEnabled, compileVendored, spansOf, type VendoredPackSelection } from "./match.js";

const unitKind = (where: string): "name" | "description" | "inputSchema" =>
  where === "name" ? "name" : where === "description" ? "description" : "inputSchema";

/** admission findings from the MCP heuristics pack (counts and locations only) */
export function vendoredMcpFindings(
  tools: readonly ScannableTool[],
  opts: { packs?: VendoredPackSelection; rules?: readonly VendoredMcpHeuristic[] } = {},
): McpAdmissionFinding[] {
  const rules = opts.rules ?? VENDORED_MCP_HEURISTICS;
  if (rules.length === 0 || !vendoredPackEnabled(opts.packs, "agt-mcp-heuristics")) return [];
  const out: McpAdmissionFinding[] = [];
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    for (const unit of scanUnitsForTool(tool)) {
      const kind = unitKind(unit.where);
      for (const rule of rules) {
        if (!rule.where.includes(kind)) continue;
        const re = compileVendored(rule.id, rule.pattern, rule.caseInsensitive);
        if (!re) continue;
        let count = 0;
        for (const _ of spansOf(re, unit.text)) count += 1;
        if (count > 0) out.push({ rule: rule.id, severity: rule.severity, tool: name, where: unit.where, count });
      }
    }
  }
  return out;
}
