/**
 * ADR-0187 X28 — the scan status of a model artifact, and the `engine_scan`
 * evidence chip a model card shows for a cited scan.
 *
 * The status is computed by `scanStatus` (modelArtifacts.ts), which re-checks
 * the gateway's verdict: only a verified safetensors scan with no finding is
 * clean; not-run, unknown, unrecognised and never-scanned are never clean. The
 * badge always carries a word as well as a tone, so colour is never the only
 * signal.
 */
import { Link } from "react-router-dom";
import { Badge, IdChip } from "../../../ui/kit";
import { scanStatus, statusWord, SCAN_ENGINE_ID, type ArtifactScan, type ModelArtifact, type ScanStatus } from "./modelArtifacts";
import m from "./modelArtifacts.module.css";

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

/** the status word and the gateway's chip wording, side by side */
export function ScanStatusBadge(props: { status: ScanStatus }) {
  const s = props.status;
  return (
    <span className={m.status} data-testid="scan-status" data-clean={s.clean ? "true" : "false"}>
      <Badge tone={s.tone}>{statusWord(s)}</Badge>
      <span>{s.label}</span>
    </span>
  );
}

/** the reasons, as a list a screen reader names */
export function ScanReasons(props: { status: ScanStatus; label?: string }) {
  const s = props.status;
  if (s.reasons.length === 0) return null;
  return (
    <ul className={m.reasons} aria-label={props.label ?? (s.clean ? "Why it is clean" : "Why it is not clean")}>
      {s.reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

/**
 * The model card's chip for an `engine_scan` evidence row: engine, version,
 * result, date, and a link to the artifact's scan (with its run). `scan` null
 * means the gateway could not find the cited scan: shown as unavailable, never
 * as clean.
 */
export function EngineScanEvidenceChip(props: { scan: ArtifactScan | null | undefined; artifact?: Pick<ModelArtifact, "format" | "executable"> | null }) {
  const scan = props.scan ?? null;
  if (!scan) {
    return (
      <span className={m.chip} data-testid="engine-scan-chip">
        <span className={m.status}>
          <Badge tone="warn">Not clean</Badge>
          <span>Scan record unavailable</span>
        </span>
        <span className={m.chipMeta}>The cited scan could not be read, so it counts as inconclusive.</span>
      </span>
    );
  }
  const status = scanStatus(scan, props.artifact ?? null);
  // B5W-01: the link names THIS scan, so the page shows it and not a newer one
  const to = `/admin/admission?tab=artifacts&artifact=${encodeURIComponent(scan.artifactId)}&scan=${encodeURIComponent(scan.id)}`;
  return (
    <span className={m.chip} data-testid="engine-scan-chip">
      <ScanStatusBadge status={status} />
      <span className={m.chipMeta}>
        <span>
          Engine: {SCAN_ENGINE_ID} {scan.scannerVersion ? `v${scan.scannerVersion}` : "(version not recorded)"}
        </span>
        <span>Scanned {day(scan.createdAt)}</span>
        <span>{status.admissible ? "Admissible" : "Not admissible"}</span>
      </span>
      <span className={m.chipMeta}>
        {scan.engineRunId ? (
          <>
            <Link to={`${to}&run=${encodeURIComponent(scan.engineRunId)}`}>View the scan and its run</Link>
            <span>
              run <IdChip id={scan.engineRunId} />
            </span>
          </>
        ) : (
          <>
            <Link to={to}>View the scan</Link>
            <span>no run recorded</span>
          </>
        )}
      </span>
    </span>
  );
}
