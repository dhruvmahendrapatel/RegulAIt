/**
 * ADR-0187 (X27) — the three small engine-run marks: the verdict badge, the
 * run-status badge and the engine provenance chip. Each carries its meaning in
 * WORDS (colour is never the only distinction), and the verdict badge renders
 * "pass" for the literal verdict `pass` only (engineRuns.ts `verdictDisplay`).
 */
import { Badge } from "../../../ui/kit";
import { runStatusDisplay, shortDigest, verdictDisplay, type Provenance } from "./engineRuns";
import v from "../../views.module.css";

export function EngineVerdictBadge(props: { verdict: string | null | undefined }) {
  const d = verdictDisplay(props.verdict);
  return (
    <span data-testid="engine-verdict" data-verdict={props.verdict ?? ""} title={d.meaning}>
      <Badge tone={d.tone}>{d.label}</Badge>
    </span>
  );
}

export function EngineRunStatusBadge(props: { status: string }) {
  const d = runStatusDisplay(props.status);
  return (
    <span data-testid="engine-run-status" data-status={props.status}>
      <Badge tone={d.tone}>{d.label}</Badge>
    </span>
  );
}

/**
 * Engine, version, and the image digest of the build that ran it when that is
 * known for this run; otherwise it says the digest is not recorded rather than
 * showing the engine's current build as if it were the run's.
 */
export function EngineProvenanceChip(props: { provenance: Provenance }) {
  const p = props.provenance;
  const digestText = p.digest
    ? `${shortDigest(p.digest)}${p.digestSource === "runner" ? " (runner-reported)" : ""}`
    : "image digest not recorded on this run";
  const full = [
    `engine ${p.engine} ${p.version}`,
    p.digest ? `image ${p.digest}` : "image digest not recorded on this run",
    p.generation != null ? `manifest generation ${p.generation}` : null,
    p.signature ? `signature ${p.signature.replaceAll("_", " ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={v.row} data-testid="engine-provenance" title={full}>
      <Badge tone="neutral">
        engine: {p.engine} {p.version}
      </Badge>
      <code className={v.faint}>{digestText}</code>
      {p.generation != null && <span className={v.faint}>manifest gen. {p.generation}</span>}
      {p.signature && <span className={v.faint}>signature {p.signature.replaceAll("_", " ")}</span>}
    </span>
  );
}
