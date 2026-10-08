/**
 * ADR-0187 — THE ENGINE TAXONOMY MAP: a pure, versioned, shared table from an
 * engine's own vocabulary (a promptfoo plugin id, a garak probe tag) to the
 * classes this platform measures (a red-team attack class for A3 and the
 * evaluator catalog; an eval scorer kind for eval-type results).
 *
 * The server derives every item's class from THIS table and ignores the
 * engine's own `mappedClass` claim (it is kept only to show disagreement). An
 * item with no entry is reported but is never counted toward A3 or the
 * evaluator catalog ("unmapped never counts").
 *
 * The foundation ships the interface and an empty table: each engine's PR
 * (B5-P promptfoo, B5-G garak) adds its rows from its G19 research, bumping
 * `ENGINE_TAXONOMY.version`, and a run records the version it was mapped with.
 */
import type { RedTeamAttackClass } from "../redteam.js";
import type { EvalScorerKind } from "../evals.js";

export interface EngineTaxonomyEntry {
  /** the engine's vocabulary (`sourceTaxonomy.system` in the envelope) */
  system: string;
  /** the engine's id within it (`sourceTaxonomy.id`) */
  id: string;
  /** the red-team attack class it measures, or null */
  attackClass: RedTeamAttackClass | null;
  /** the eval scorer kind it measures, or null */
  scorerKind: EvalScorerKind | null;
}

export interface EngineTaxonomy {
  /** bumped on every change; stored on each run's summary */
  version: number;
  entries: readonly EngineTaxonomyEntry[];
}

/** THE TABLE (empty until an engine PR fills its rows) */
export const ENGINE_TAXONOMY: EngineTaxonomy = Object.freeze({ version: 1, entries: Object.freeze([]) });

/** the entry for one (system, id), or null when the item is unmapped */
export function lookupEngineTaxonomy(
  taxonomy: EngineTaxonomy,
  system: string,
  id: string,
): EngineTaxonomyEntry | null {
  return taxonomy.entries.find((e) => e.system === system && e.id === id) ?? null;
}

/** problems with a table (duplicate keys): a table with any is refused by its test */
export function engineTaxonomyProblems(taxonomy: EngineTaxonomy): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of taxonomy.entries) {
    const k = `${e.system}\u0000${e.id}`;
    if (seen.has(k)) out.push(`duplicate entry ${e.system}/${e.id}`);
    seen.add(k);
    if (e.attackClass === null && e.scorerKind === null) out.push(`entry ${e.system}/${e.id} maps to nothing`);
  }
  return out;
}
