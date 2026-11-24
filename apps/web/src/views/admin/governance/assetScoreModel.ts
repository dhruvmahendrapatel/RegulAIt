/**
 * Per-asset posture scores: the shapes of `GET /v1/reports/posture/assets` (one page of one kind, name order) and
 * `GET /v1/reports/posture/assets/:kind/:assetId` (one asset), read from the gateway's asset-score.ts, plus the pure
 * helpers the screens use. Every figure arrives computed by the server; nothing here does arithmetic on a score.
 */
export type AssetKind = "agent" | "use_case";

export const ASSET_KINDS: ReadonlyArray<{ id: AssetKind; label: string }> = [
  { id: "agent", label: "Agents" },
  { id: "use_case", label: "Use cases" },
];

export interface AssetScoreLink {
  to: string;
  label: string;
}

export interface AssetScoreObjective {
  id: string;
  title: string;
  outcome: string;
  metric: { label: string; value: string };
  weight: number;
  measured: boolean;
  /** 0–100; 0 when unmeasured, so the screen shows "unmeasured" instead of this figure */
  score: number;
  contribution: number;
  inputs: Array<{ label: string; value: string }>;
  formula: string;
  link: AssetScoreLink;
}

export interface AssetScoreDoc {
  estimate: true;
  asset: { kind: AssetKind; id: string; name: string };
  score: number;
  scale: { min: number; max: number };
  method: string;
  disclaimer: string;
  weights: Array<{ objective: string; title: string; weight: number; sharePct: number }>;
  notApplicable: Array<{ objective: string; title: string; why: string }>;
  objectives: AssetScoreObjective[];
  actions: Array<{ key: string; rank: number; objective: string; title: string; points: number; reason: string; link: AssetScoreLink }>;
}

export interface AssetScorePage {
  kind: AssetKind;
  objectives: string[];
  items: AssetScoreDoc[];
  nextCursor: string | null;
  limit: number;
  disclaimer: string;
}

const isDoc = (x: unknown): x is AssetScoreDoc => {
  const d = x as AssetScoreDoc | null;
  return !!d && typeof d.score === "number" && !!d.asset && Array.isArray(d.objectives) && Array.isArray(d.weights) && Array.isArray(d.notApplicable) && Array.isArray(d.actions);
};

/** a response that is not the documented shape is a failed read, never an empty or zero score */
export function parseAssetScore(x: unknown): AssetScoreDoc {
  if (!isDoc(x)) throw new Error("The server returned a score this page cannot read.");
  return x;
}

export function parseAssetPage(x: unknown): AssetScorePage {
  const pg = x as AssetScorePage | null;
  if (!pg || !Array.isArray(pg.items) || !pg.items.every(isDoc)) throw new Error("The server returned a list this page cannot read.");
  return pg;
}

/** the server's page ceiling */
export const ASSET_PAGE_LIMIT = 100;

export function assetListPath(kind: AssetKind, cursor: string | null): string {
  const q = new URLSearchParams({ kind, limit: String(ASSET_PAGE_LIMIT) });
  if (cursor) q.set("cursor", cursor);
  return `/v1/reports/posture/assets?${q.toString()}`;
}

export function assetDetailPath(kind: AssetKind, assetId: string): string {
  return `/v1/reports/posture/assets/${kind}/${encodeURIComponent(assetId)}`;
}

/** an objective's own figure: an unmeasured one says so and never shows its zero */
export function objectiveScoreText(o: Pick<AssetScoreObjective, "measured" | "score">): string {
  return o.measured ? `${o.score} of 100` : "Unmeasured";
}

/** the share an objective carries in this asset's score, from the server's weights list */
export function shareText(doc: Pick<AssetScoreDoc, "weights">, objective: string): string {
  const w = doc.weights.find((x) => x.objective === objective);
  return w ? `${w.sharePct}%` : "—";
}

export const pointsText = (x: number) => `${x} ${x === 1 ? "point" : "points"}`;
