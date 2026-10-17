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
 *
 * ADR-0190 owner decision C (slice A1): when the signed facts name a person's own stdio relaxation, its record (who
 * set it, its scope, when, and a link to the audit row that set it) is shown beside them, marked as not signed.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AdminUser } from "../../../api/adminTypes";
import { actorLabel } from "../../../api/format";
import { adminKeys } from "../adminKit";
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
  placementEndLabel,
  placementReportLabel,
  saveBlob,
  sectionLabel,
  shownTime,
  auditRowHref,
  type ExecutionView,
  type PlacementReportView,
  type RelaxationRecordView,
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
  // a mismatch's class is what the placement report claimed, which the gateway refused: the call never ran under it (decision 6)
  if (e.placement !== "refused") rows.push({ key: "applied", label: e.placement === "mismatch" ? "Reported class (disputed)" : "Applied isolation", value: isolationClassLabel(e.appliedClass) });
  // ADR-0190 owner decision C: the unknown-agent floor was lowered to L2 for an interactive person's own call
  if (e.relaxation) {
    rows.push({
      key: "relaxation",
      label: "Isolation relaxation",
      value: (
        <>
          A person&apos;s own call, L3 lowered to L2 by an admin for this {e.relaxation.scopeKind === "mcp_server" ? "MCP server" : "project"} · relaxation{" "}
          <code className={v.mono}>{e.relaxation.relaxationId}</code>
        </>
      ),
    });
  }
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
  // ADR-0190 I4: the offer, the closure image and the runtime flags hash the placement row was stamped with
  if (e.offerId) rows.push({ key: "offer", label: "Offer", value: <code className={v.mono}>{e.offerId}</code> });
  if (e.imageDigest) rows.push({ key: "image", label: "Closure image", value: <code className={v.mono}>{e.imageDigest}</code> });
  if (e.runtimeFlagsSha256) rows.push({ key: "flags", label: "Runtime flags", value: <Digest value={e.runtimeFlagsSha256} /> });
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
      {e.placement === "placed" && e.attestation && <p className={v.faint}>Software-attested: the reports come from software on the same host, not from hardware-rooted attestation.</p>}
    </div>
  );
}

/** ADR-0190 I4: what happened to an offered placement after the decision (live and unsigned, beside the signed body) */
export function PlacementReports({ reports }: { reports: PlacementReportView[] }) {
  return (
    <div className={v.stack} data-testid="decision-bom-placement-reports">
      <div className={v.sectionTitle}>After the decision</div>
      <p className={v.faint}>These records were written after the decision and are not part of the signed Decision BOM.</p>
      <Table
        rows={reports}
        rowKey={(r) => r.id}
        columns={[
          { key: "outcome", header: "Outcome", render: (r) => `${placementReportLabel(r.outcome)}${r.endCode ? `: ${placementEndLabel(r.endCode)}` : ""}` },
          { key: "class", header: "Class", render: (r) => (r.appliedClass ? isolationClassLabel(r.appliedClass) : "—") },
          { key: "detail", header: "Detail", render: (r) => (r.reportSha256 ? <Digest value={r.reportSha256} /> : r.refusalCode ? <code className={v.mono}>{r.refusalCode}</code> : "—") },
          { key: "at", header: "Recorded", render: (r) => r.createdAt },
        ]}
      />
    </div>
  );
}

/**
 * ADR-0190 owner decision C (A1): the record of the relaxation the signed facts name: its id, who set it, its scope,
 * when, and the audit row that set it (live, unsigned). `record` undefined = the gateway did not report it.
 */
export function RelaxationRecord({ record, names }: { record: RelaxationRecordView | undefined; names: Map<string, string> }) {
  if (record === undefined) {
    return (
      <div className={v.stack} data-testid="decision-bom-relaxation-record">
        <div className={v.sectionTitle}>The isolation relaxation</div>
        <p role="status">Not reported: this gateway does not say who set the relaxation or when.</p>
      </div>
    );
  }
  const scope = record.scopeKind === "mcp_server" ? "MCP server" : "Project";
  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = [
    { key: "id", label: "Relaxation", value: <code className={v.mono}>{record.id}</code> },
    { key: "scope", label: "Scope", value: <>{scope} <code className={v.mono}>{record.scopeId}</code></> },
    { key: "setBy", label: "Set by", value: <>{actorLabel(record.setBy, names)} (<code className={v.mono}>{record.setBy}</code>)</> },
    { key: "setAt", label: "Set at", value: shownTime(record.setAt) },
    {
      key: "audit",
      label: "Audit row",
      value: record.setAuditId ? (
        <Link to={auditRowHref(record.setAuditId)} aria-label={`Open the audit row that set relaxation ${record.id}`}>
          {record.setAuditId}
        </Link>
      ) : (
        "Not found: the audit row may have been pruned by the retention policy"
      ),
    },
    {
      key: "state",
      label: "Today",
      value: record.clearedAt ? `Cleared ${shownTime(record.clearedAt)} by ${actorLabel(record.clearedBy, names)}; L3 applies again` : "Still in force",
    },
  ];
  return (
    <div className={v.stack} data-testid="decision-bom-relaxation-record">
      <div className={v.sectionTitle}>The isolation relaxation</div>
      <p className={v.faint}>From the relaxation&apos;s own record, not part of the signed Decision BOM. The signed facts name its id and scope.</p>
      <Table rows={rows} rowKey={(r) => r.key} columns={[{ key: "label", header: "Field", render: (r) => r.label }, { key: "value", header: "Value", render: (r) => r.value }]} />
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
  // A1: names for who set a relaxation (an administrator's user list; an auditor sees ids)
  const users = useQuery({
    queryKey: adminKeys.users,
    queryFn: () => api.get<{ users: AdminUser[] }>("/v1/users"),
    enabled: Boolean(view?.execution?.relaxation) && view?.capabilities.access === "admin",
  });
  const names = new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email]));
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
              {view.execution?.placement === "offered" && view.placementReports.length > 0 && <PlacementReports reports={view.placementReports} />}
              {view.execution?.relaxation && view.relaxationRecord !== null && <RelaxationRecord record={view.relaxationRecord} names={names} />}
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
