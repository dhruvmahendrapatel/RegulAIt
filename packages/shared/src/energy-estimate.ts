/**
 * ADR-0175 A15 — ESTIMATED ENERGY AND EMISSIONS, pure half.
 *
 *   energy (Wh)     = input tokens / 1000 × Wh per 1k input
 *                   + output tokens / 1000 × Wh per 1k output   (per model factor)
 *   emissions (g)   = energy (kWh) × grid intensity (gCO2e per kWh)
 *
 * Every number here is an ESTIMATE built from admin-entered factors, and is
 * returned with the factors' sources and versions. Three honesty rules:
 *
 *  1. A model with no factor is UNKNOWN, never zero. Its calls are counted in
 *     `callsUnknown` and listed in `unknownModels`; the totals cover only the
 *     estimated calls and say "N of M calls estimated".
 *  2. A call whose token counts were not recorded cannot be estimated either,
 *     even when its model has a factor.
 *  3. With no estimated call at all, the totals are null ("unknown"), not 0.
 *     With no grid intensity, energy may be known while emissions are null.
 *  4. (review fix) A DEMO factor describes the mock provider only. It applies
 *     to calls the mock provider served (`servedByMock`), and to nothing else:
 *     a real provider's calls of a model with only a demo factor are unknown.
 */

export const ENERGY_ESTIMATE_LABEL =
  "Estimate: ledger tokens × admin-entered per-model energy factors × grid intensity. Not a measurement.";

export interface EnergyUsageRow {
  /** the configured model id on the usage ledger */
  model: string | null;
  calls: number;
  /** calls of this model whose input and output tokens were both recorded */
  callsWithTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** true when the agent that served these calls is a mock-provider agent;
   * only such calls may be estimated with a demo factor */
  servedByMock?: boolean;
}

export interface EnergyFactorInput {
  subject: string;
  whPer1kInput: number;
  whPer1kOutput: number;
  sourceNote: string;
  version: string;
  demo: boolean;
}

export interface EnergyGridInput {
  /** 'default' or a region name */
  subject: string;
  gCo2ePerKwh: number;
  sourceNote: string;
  version: string;
  demo: boolean;
}

export interface EnergyEstimate {
  label: string;
  windowDays: number;
  callsTotal: number;
  callsEstimated: number;
  callsUnknown: number;
  /** "N of M calls estimated" */
  coverage: string;
  /** null = unknown (no call could be estimated) */
  energyWh: number | null;
  /** null = unknown (no estimated call, or no grid intensity) */
  emissionsG: number | null;
  grid: (EnergyGridInput & { region: string | null }) | null;
  byModel: Array<{
    model: string;
    calls: number;
    callsEstimated: number;
    inputTokens: number;
    outputTokens: number;
    energyWh: number | null;
    factor: Omit<EnergyFactorInput, "subject"> | null;
    status: "estimated" | "no_factor" | "no_tokens";
    /** set only where a model's calls are split by who served them, because
     * its factor is a demo value that applies to the mock provider alone */
    servedBy?: "mock" | "not_mock";
    note?: string;
  }>;
  unknownModels: string[];
  /** true when any factor used is a demo value */
  usesDemoFactors: boolean;
}

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

export function estimateEnergy(input: {
  windowDays: number;
  usage: EnergyUsageRow[];
  factors: EnergyFactorInput[];
  grid: (EnergyGridInput & { region: string | null }) | null;
}): EnergyEstimate {
  const factorOf = new Map(input.factors.map((f) => [f.subject.trim().toLowerCase(), f]));
  // merged per model; a model whose factor is a DEMO value is split by
  // whether the mock provider served the calls, since only those may use it
  const merged = new Map<string, EnergyUsageRow & { lower: string; servedBy?: "mock" | "not_mock" }>();
  for (const r of input.usage) {
    const name = (r.model ?? "(no model recorded)").trim();
    const lower = name.toLowerCase();
    const servedBy = factorOf.get(lower)?.demo ? (r.servedByMock ? "mock" : "not_mock") : undefined;
    const key = servedBy ? `${lower}\u0000${servedBy}` : lower;
    const m = merged.get(key) ?? { model: name, lower, calls: 0, callsWithTokens: 0, inputTokens: 0, outputTokens: 0, ...(servedBy ? { servedBy } : {}) };
    m.calls += r.calls;
    m.callsWithTokens += r.callsWithTokens;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    merged.set(key, m);
  }
  let callsTotal = 0;
  let callsEstimated = 0;
  let energy = 0;
  let usesDemo = false;
  const byModel: EnergyEstimate["byModel"] = [];
  const unknown: string[] = [];
  for (const [key, r] of [...merged.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))) {
    callsTotal += r.calls;
    const split = r.servedBy ? { servedBy: r.servedBy } : {};
    if (r.servedBy === "not_mock") {
      // the only factor is a demo value, and these calls were not the mock's
      unknown.push(r.model!);
      byModel.push({
        model: r.model!,
        calls: r.calls,
        callsEstimated: 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        energyWh: null,
        factor: null,
        status: "no_factor",
        ...split,
        note: "Its only factor is a demo value, which applies to the mock provider's calls alone.",
      });
      continue;
    }
    const f = r.model && key !== "(no model recorded)" ? factorOf.get(r.lower) : undefined;
    if (!f) {
      unknown.push(r.model!);
      byModel.push({ model: r.model!, calls: r.calls, callsEstimated: 0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, energyWh: null, factor: null, status: "no_factor" });
      continue;
    }
    const factor = { whPer1kInput: f.whPer1kInput, whPer1kOutput: f.whPer1kOutput, sourceNote: f.sourceNote, version: f.version, demo: f.demo };
    if (r.callsWithTokens === 0) {
      byModel.push({ model: r.model!, calls: r.calls, callsEstimated: 0, inputTokens: 0, outputTokens: 0, energyWh: null, factor, status: "no_tokens", ...split });
      continue;
    }
    const wh = (r.inputTokens / 1000) * f.whPer1kInput + (r.outputTokens / 1000) * f.whPer1kOutput;
    energy += wh;
    callsEstimated += r.callsWithTokens;
    usesDemo ||= f.demo;
    byModel.push({
      model: r.model!,
      calls: r.calls,
      callsEstimated: r.callsWithTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      energyWh: round(wh),
      factor,
      status: "estimated",
      ...split,
    });
  }
  const energyWh = callsEstimated > 0 ? round(energy) : null;
  const emissionsG = energyWh !== null && input.grid ? round((energyWh / 1000) * input.grid.gCo2ePerKwh) : null;
  if (input.grid?.demo && energyWh !== null) usesDemo = true;
  return {
    label: ENERGY_ESTIMATE_LABEL,
    windowDays: input.windowDays,
    callsTotal,
    callsEstimated,
    callsUnknown: callsTotal - callsEstimated,
    coverage: `${callsEstimated} of ${callsTotal} calls estimated`,
    energyWh,
    emissionsG,
    grid: input.grid,
    byModel,
    unknownModels: unknown,
    usesDemoFactors: usesDemo,
  };
}
