/**
 * ADR-0189 §9 / B6: the Decision BOM of one decision, opened from an audit-log
 * row or from the Decision receipts panel.
 *
 * Opening it reads `GET /v1/decisions/:auditId/bom`, which assembles and
 * freezes version 1 the first time (OWNER DECISION 3) and is audited, so the
 * panel is only mounted on an explicit click. A decision that is not final
 * yet answers 409 `bom_anchor_pending` with its reason; that is shown, with a
 * retry, never as an empty or successful BOM. Completeness is shown as
 * recorded: a section that was not recorded says so and why, and is never
 * filled in from today's state.
 *
 * ADR-0190 I8: a v2 body's execution facts (where the call ran, the class it
 * required and why, the profile, the executor and the attestation references)
 * are shown from the signed body itself. L0 and L1 are never called a sandbox.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Field, Select, Table } from "../../../ui/kit";
import { bomB4Api, type BomEvidencePort } from "./bomB4Api";
import { BomVerifyPanel, Digest, OfflineVerifyNote, VerifyResult, exportUnavailableText } from "./BomEvidencePanel";
import {
  bomRefusalText,
  checkedAuditId,
  executionPlacementLabel,
  finalityLabel,
  isolationClassLabel,
  requiredByLabel,
  formatLabel,
  isBomForbidden,
  notRecordedLabel,
  saveBlob,
  sectionLabel,
  shownTime,
  type ExecutionView,
  type VerifyView,
} from "./bomModel";
import v from "../../views.module.css";

/** ADR-0190 decision 9 / I8: the execution section of a v2 Decision BOM, as signed */
export function ExecutionFacts({ execution: e }: { execution: ExecutionView }) {
  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = [
    { key: "placement", label: "Where it ran", value: executionPlacementLabel(e.placement) },
    { key: "kind", label: "Workload kind", value: <code className={v.mono}>{e.workloadKind}</code> },
  ];
  if (e.requiredClass) rows.push({ key: "required", label: "Required isolation", value: `${isolationClassLabel(e.requiredClass)}${e.requiredBy ? `, set by ${requiredByLabel(e.requiredBy)}` : ""}` });
  if (e.placement !== "refused") rows.push({ key: "applied", label: "Applied isolation", value: isolationClassLabel(e.appliedClass) });
  if (e.refusalCode) rows.push({ key: "refusal", label: "Refusal", value: <code className={v.mono}>{e.refusalCode}</code> });
  if (e.profile) rows.push({ key: "profile", label: "Execution profile", value: <>{e.profile.name} version {e.profile.version} · <Digest value={e.profile.digest} /></> });
  if (e.executor) {
    rows.push({
      key: "executor",
      label: "Executor",
      value: (
        <>
          {e.executor.backend} {e.executor.runtimeVersion} · <code className={v.mono}>{e.executor.identity ?? e.executor.identityId}</code>
        </>
      ),
    });
  }
  if (e.attestation) {
    rows.push({
      key: "attestation",
      label: "Attestation",
      value: (
        <>
          {e.attestation.placementReportSha256 ? <>placement report <Digest value={e.attestation.placementReportSha256} /></> : "no placement report"}
          {" · "}
          {e.attestation.executorReportSha256 ? <>executor self-test <Digest value={e.attestation.executorReportSha256} /></> : "no fresh executor self-test recorded"}
        </>
      ),
    });
  }
  return (
    <div className={v.stack} data-testid="decision-bom-execution">
      <div className={v.sectionTitle}>Execution</div>
      <Table rows={rows} rowKey={(r) => r.key} columns={[{ key: "label", header: "Fact", render: (r) => r.label }, { key: "value", header: "Recorded", render: (r) => r.value }]} />
      {e.attestation && <p className={v.faint}>Software-attested: the reports come from software on the same host, not from hardware-rooted attestation.</p>}
    </div>
  );
}

export function DecisionBomPanel({ auditId, evidencePort = bomB4Api, onClose }: { auditId: string; evidencePort?: BomEvidencePort; onClose?: () => void }) {
  let id: string | null = null;
  try {
    id = checkedAuditId(auditId);
  } catch {
    id = null;
  }
  const [version, setVersion] = useState<number | undefined>(undefined);
  const read = useQuery({
    queryKey: ["bom", "decision", id, version ?? "newest"],
    queryFn: () => evidencePort.decision(id!, version),
    enabled: id !== null,
    retry: false,
  });
  const [busy, setBusy] = useState<"verify" | "download" | null>(null);
  const [verified, setVerified] = useState<VerifyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (what: "verify" | "download", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(bomRefusalText(e));
    } finally {
      setBusy(null);
    }
  };

  const view = read.data;
  const blocked = exportUnavailableText(view?.capabilities);
  return (
    <div className={v.stack} data-testid="decision-bom-panel">
      <Card
        title="Decision BOM"
        actions={
          onClose ? (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          ) : undefined
        }
      >
        <div className={v.stack}>
          {id === null ? (
            <p className={v.errLine} role="alert">
              Enter the decision&rsquo;s audit row ID (a UUID).
            </p>
          ) : (
            <p>
              Audit row <code className={v.mono}>{id}</code>. The signed record of what this decision was made with: ids, versions, digests and
              classifications as recorded at the time, never today&rsquo;s state. Opening it is audited.
            </p>
          )}
          {read.isLoading && <p role="status">Reading the Decision BOM…</p>}
          {read.error && (
            <p className={isBomForbidden(read.error) ? undefined : v.errLine} role="alert">
              {bomRefusalText(read.error)}{" "}
              {!isBomForbidden(read.error) && (
                <Button size="sm" onClick={() => void read.refetch()}>
                  Retry
                </Button>
              )}
            </p>
          )}
          {view && (
            <>
              <div className={v.row}>
                <Badge tone={view.bom.reportedFinality === "chain_signed" || view.bom.reportedFinality === "anchored_lapsed" || view.bom.reportedFinality === "anchored_unverified_destination" ? "warn" : "ok"}>
                  {finalityLabel(view.bom.reportedFinality)}
                </Badge>
                {view.bom.reportedFinality !== view.bom.finality && <span className={v.faint}>Frozen as {finalityLabel(view.bom.finality)}; the lock has since lapsed.</span>}
              </div>
              {view.versions.length > 1 && (
                <Field label="Version">
                  <Select value={String(view.bom.version)} onChange={(e) => {
                    setVersion(Number(e.target.value));
                    setVerified(null);
                    setNotice(null);
                    setError(null);
                  }}>
                    {view.versions.map((x) => (
                      <option key={x.id} value={x.version}>
                        Version {x.version} ({finalityLabel(x.finality)}, {shownTime(x.createdAt)})
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <p>
                Version {view.bom.version} of {view.versions.length}, frozen {shownTime(view.bom.createdAt)} · signed with key <code className={v.mono}>{view.bom.keyId}</code> ·
                body SHA-256 <Digest value={view.bom.bodySha256} />
                {view.bom.aiBomSnapshotId ? (
                  <>
                    {" "}· AI BOM snapshot <code className={v.mono}>{view.bom.aiBomSnapshotId}</code>
                  </>
                ) : null}
                {view.renderings.length ? ` · renderings: ${view.renderings.map(formatLabel).join(", ")}` : ""}
              </p>
              <Table
                rows={view.completeness}
                rowKey={(c) => c.section}
                columns={[
                  { key: "section", header: "Section", render: (c) => sectionLabel(c.section) },
                  {
                    key: "status",
                    header: "Recorded",
                    render: (c) =>
                      c.status === "recorded" ? (
                        <Badge tone="ok">recorded</Badge>
                      ) : c.status === "not_applicable" ? (
                        <Badge tone="neutral">not applicable</Badge>
                      ) : (
                        <Badge tone="warn">not recorded</Badge>
                      ),
                  },
                  { key: "reason", header: "Why not", render: (c) => (c.reason ? notRecordedLabel(c.reason) : "—") },
                ]}
              />
              {view.execution && <ExecutionFacts execution={view.execution} />}
              <div className={v.row}>
                <Button
                  size="sm"
                  disabled={busy !== null || !view.capabilities.canVerify}
                  onClick={() => void run("verify", async () => setVerified(await evidencePort.verifyDecision(view.auditId, view.bom.version)))}
                >
                  {busy === "verify" ? "Verifying…" : "Verify this version"}
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || blocked !== null}
                  onClick={() =>
                    void run("download", async () => {
                      const d = await evidencePort.downloadDecision(view);
                      saveBlob(d.blob, d.filename);
                      setNotice(`Saved ${d.filename} (archive SHA-256 ${d.archiveSha256.slice(0, 16)}…, export key ${d.exportKeyId}). The download is audited. Verify it before relying on it.`);
                    })
                  }
                >
                  {busy === "download" ? "Downloading…" : "Download bundle"}
                </Button>
              </div>
              {blocked && <p role="status">{blocked}</p>}
              <p className={v.faint}>
                Your access: {view.capabilities.access === "admin" ? "administrator" : "auditor grant"}. Exports are limited to {view.capabilities.rateLimitPerMinute} BOM requests a minute
                per person.
              </p>
            </>
          )}
          {error && (
            <p className={v.errLine} role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {verified && <VerifyResult result={verified} />}
          <OfflineVerifyNote />
        </div>
      </Card>
      <BomVerifyPanel evidencePort={evidencePort} />
    </div>
  );
}
