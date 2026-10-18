/**
 * ADR-0189 §9 / B6: the AI BOM tab (use case overview, agents, model risk) and
 * the shared verify views. What it shows, and what it never claims:
 *
 *  - Snapshots are listed as metadata only: version, trigger, time, formats,
 *    key id and digests. No BOM body, prompt, output or credential is shown.
 *  - "Take snapshot" freezes and signs one on demand. With no usable receipt
 *    key the gateway refuses (409 `bom_signing_unavailable`, 503
 *    `receipt_signing_key_invalid`) and the refusal is shown as such: nothing
 *    was stored.
 *  - Drift is a change list, marked "Not evidence" (R8), with the subject's
 *    snapshot gaps: sign-offs that took no snapshot (R25 item 4).
 *  - A download is saved only after its transport checks pass (`bomB4Api`).
 *    Verification is the gateway's verifier against the deployment's own
 *    recorded keys, and the result says so; independent assurance is the
 *    offline verifier with keys obtained separately.
 */
import { useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table, type Tone } from "../../../ui/kit";
import { bomMetadataApi, type BomMetadataPort } from "./bomApi";
import { bomB4Api, type BomEvidencePort } from "./bomB4Api";
import {
  GAP_LABELS,
  OUTCOME_LABELS,
  bomRefusalText,
  cannotProveText,
  checkLabel,
  downloadableFormats,
  driftRefKind,
  finalityLabel,
  formatLabel,
  isBomForbidden,
  notRecordedLabel,
  saveBlob,
  sectionLabel,
  shownTime,
  triggerLabel,
  type BomCapabilities,
  type BomDriftChange,
  type BomFormat,
  type BomGaps,
  type BomSnapshot,
  type BomSubject,
  type DriftSide,
  type VerifyView,
} from "./bomModel";
import v from "../../views.module.css";

const OUTCOME_TONE: Record<VerifyView["outcome"], Tone> = { valid: "ok", unverifiable: "warn", invalid: "danger" };
const STATUS_TONE: Record<string, Tone> = { valid: "ok", unverifiable: "warn", invalid: "danger" };

/** visually hidden, still read by assistive technology */
const SR_ONLY: CSSProperties = { position: "absolute", width: 1, height: 1, padding: "0", margin: "calc(-1 * var(--s-hair))", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 };

/** a digest, shortened for the eye; the whole value is the title and is read out in full to assistive technology */
export function Digest({ value }: { value: string }) {
  return (
    <code className={v.mono} title={value}>
      <span aria-hidden="true">{value.slice(0, 16)}…</span>
      <span style={SR_ONLY}>{value}</span>
    </code>
  );
}

/** why exporting is not possible right now, from the capabilities the gateway sent */
export function exportUnavailableText(c: BomCapabilities | null | undefined): string | null {
  if (!c || c.canExport) return null;
  return c.exportUnavailableReason === "export_signing_key_absent"
    ? "Export is unavailable: no export signing key is configured, so no bundle can be built."
    : "Export is unavailable for your account.";
}

// ---------------------------------------------------------------------------
// a verification result
// ---------------------------------------------------------------------------

export function VerifyResult({ result }: { result: VerifyView }) {
  const id = result.identity;
  const byDesign = result.checks.filter((c) => c.byDesign).length;
  return (
    <div className={v.stack} data-testid="bom-verify-result">
      {/* only the outcome line is announced; the tables below are read on demand */}
      <div className={v.row} role="status">
        <Badge tone={OUTCOME_TONE[result.outcome]}>{OUTCOME_LABELS[result.outcome]}</Badge>
        <span className={v.faint}>Verified {shownTime(result.verifiedAt)} against this deployment&rsquo;s recorded keys.</span>
      </div>
      <p className={v.faint}>
        The trust root is this deployment&rsquo;s own key registry. A key carried inside a bundle never establishes who signed it. For
        independent assurance, verify the bundle offline with keys you obtained separately.
      </p>
      {id?.subject === "decision-bom" && (
        <p>
          Decision BOM for audit row <code className={v.mono}>{id.auditId}</code>, version {id.version}. Recorded finality: {finalityLabel(id.recordedFinality)}
          {id.reportedFinality !== id.recordedFinality ? `; now ${finalityLabel(id.reportedFinality)}` : ""}. Receipt payload {id.receiptPayloadVersion}.
        </p>
      )}
      {id?.subject === "ai-bom" && (
        <p>
          AI BOM snapshot version {id.version} of {id.subjectKind.replace(/_/g, " ")} <code className={v.mono}>{id.subjectId}</code>, serial{" "}
          <code className={v.mono}>{id.serialNumber}</code>.
        </p>
      )}
      {id === null && <p>The bundle could not be read far enough to tell what it holds.</p>}
      <Table
        rows={result.checks}
        rowKey={(c) => `${c.check}:${c.ref ?? ""}`}
        columns={[
          { key: "check", header: "Check", render: (c) => checkLabel(c.check) },
          {
            key: "status",
            header: "Result",
            render: (c) => (
              <Badge tone={c.byDesign ? "neutral" : (STATUS_TONE[c.status] ?? "neutral")}>
                {c.status === "valid" ? "valid" : c.byDesign ? "not checkable by design" : c.status}
              </Badge>
            ),
          },
          { key: "reason", header: "Reason", render: (c) => (c.reason ? <code className={v.mono}>{c.reason}</code> : "—") },
          { key: "ref", header: "Checked", render: (c) => (c.ref ? <code className={v.mono}>{c.ref}</code> : "—") },
        ]}
      />
      {byDesign > 0 && (
        <p className={v.faint}>
          {byDesign} check{byDesign === 1 ? " is" : "s are"} not checkable by design: the evidence a correct BOM would need is never exported. They
          do not lower the outcome, and their limits are listed below.
        </p>
      )}
      {result.sections.length > 0 && (
        <Table
          rows={result.sections}
          rowKey={(s) => s.section}
          columns={[
            { key: "section", header: "Section", render: (s) => sectionLabel(s.section) },
            { key: "status", header: "Recomputed", render: (s) => <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge> },
            {
              key: "completeness",
              header: "Recorded",
              render: (s) => (s.completeness === "not_recorded" ? `Not recorded: ${notRecordedLabel(s.notRecordedReason)}` : s.completeness.replace(/_/g, " ")),
            },
          ]}
        />
      )}
      <div>
        <div className={v.sectionTitle}>What this cannot prove</div>
        <ul>
          {result.cannotProve.map((c) => (
            <li key={c}>{cannotProveText(c)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function OfflineVerifyNote() {
  return (
    <p className={v.faint}>
      Offline: <code className={v.mono}>node scripts/verify-bom.mjs &lt;bundle.tar.gz&gt; --fingerprint sha256:… --receipt-keyring keys.json</code>. Supply the
      export key fingerprint and the receipt keys from a source other than the bundle; the keys inside it are convenience copies, never the trust
      root. Keep the downloaded bytes unchanged.
    </p>
  );
}

// ---------------------------------------------------------------------------
// verify an uploaded bundle
// ---------------------------------------------------------------------------

export function BomVerifyPanel({ evidencePort = bomB4Api }: { evidencePort?: BomEvidencePort }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const verify = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await evidencePort.verifyBundle(file));
    } catch (e) {
      setForbidden(isBomForbidden(e));
      setError(bomRefusalText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Verify a BOM bundle">
      <div className={v.stack}>
        <p className={v.faint}>Checks an export-bundle/3 (a Decision BOM or an AI BOM, up to 8 MiB) with this deployment&rsquo;s verifier. The verify is audited.</p>
        <Field label="BOM bundle (.tar.gz)">
          <Input
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            disabled={busy || forbidden}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setError(null);
            }}
          />
        </Field>
        {!forbidden && (
          <div>
            <Button size="sm" disabled={!file || busy} onClick={() => void verify()}>
              {busy ? "Verifying…" : "Verify bundle"}
            </Button>
          </div>
        )}
        {error && (
          <p className={v.errLine} role="alert">
            {error}
          </p>
        )}
        {result && <VerifyResult result={result} />}
        <OfflineVerifyNote />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// drift (R8) and gaps (R25)
// ---------------------------------------------------------------------------

const sideText = (s: DriftSide | null) => (s === null ? "—" : `${s.version ?? "no version"} · ${s.hashes.length} hash${s.hashes.length === 1 ? "" : "es"}`);

export function GapsList({ gaps }: { gaps: BomGaps }) {
  if (gaps.gaps.length === 0) return <p className={v.faint}>No snapshot gaps recorded for this subject in this period.</p>;
  return (
    <div className={v.stack} data-testid="bom-gaps">
      <div className={v.sectionTitle}>Sign-offs that took no snapshot</div>
      <Table
        rows={gaps.gaps}
        rowKey={(g) => g.auditId}
        columns={[
          { key: "at", header: "When", render: (g) => <span title={g.at}>{shownTime(g.at)}</span> },
          { key: "kind", header: "Gap", render: (g) => <Badge tone="warn">{GAP_LABELS[g.kind]}</Badge> },
          { key: "trigger", header: "Sign-off", render: (g) => triggerLabel(g.trigger) },
          { key: "code", header: "Code", render: (g) => (g.code ? <code className={v.mono}>{g.code}</code> : "—") },
          { key: "audit", header: "Audit row", render: (g) => <code className={v.mono}>{g.auditId}</code> },
        ]}
      />
      {gaps.gapsTruncated && <p className={v.faint}>Only the newest gaps are listed; the audit log holds them all.</p>}
    </div>
  );
}

function DriftView({ subject, port }: { subject: BomSubject; port: BomMetadataPort }) {
  const drift = useQuery({ queryKey: ["bom", "drift", subject.kind, subject.id], queryFn: () => port.drift(subject), retry: false });
  return (
    <Card title="Drift since the last snapshot">
      <div className={v.stack} data-testid="bom-drift">
        <p>
          <Badge tone="warn">Not evidence</Badge> <span className={v.faint}>A change list of the live state against the newest signed snapshot. It is not a BOM and cannot be downloaded.</span>
        </p>
        {drift.isLoading && <p role="status">Measuring drift…</p>}
        {drift.error && (
          <p className={v.errLine} role="alert">
            {bomRefusalText(drift.error)}{" "}
            <Button size="sm" onClick={() => void drift.refetch()}>
              Retry
            </Button>
          </p>
        )}
        {drift.data?.kind === "no_snapshot" && (
          <>
            <p role="status">This subject has no signed snapshot yet, so there is nothing to compare with. Take one to start a baseline.</p>
            <GapsList gaps={drift.data.gaps} />
          </>
        )}
        {drift.data?.kind === "drift" && (
          <>
            <p>
              Baseline: snapshot version {drift.data.drift.baseline.version}, taken {shownTime(drift.data.drift.baseline.createdAt)}.
            </p>
            <Table
              rows={drift.data.drift.changes}
              rowKey={(c: BomDriftChange) => `${c.ref}:${c.change}`}
              empty={<EmptyState title="No changes" body="The live inventory matches the baseline snapshot's components and hashes." />}
              columns={[
                { key: "kind", header: "Component", render: (c) => driftRefKind(c.ref) },
                { key: "ref", header: "Reference", render: (c) => <code className={v.mono}>{c.ref}</code> },
                { key: "change", header: "Change", render: (c) => c.change.replace(/_/g, " ") },
                { key: "before", header: "Snapshot", render: (c) => sideText(c.before) },
                { key: "after", header: "Live", render: (c) => sideText(c.after) },
              ]}
            />
            <GapsList gaps={drift.data.drift} />
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// one snapshot: verify and download
// ---------------------------------------------------------------------------

function SnapshotDetail({ snapshot, port, onClose }: { snapshot: BomSnapshot; port: BomEvidencePort; onClose: () => void }) {
  const formats = downloadableFormats(snapshot);
  const [format, setFormat] = useState<BomFormat | "all">("native");
  const [busy, setBusy] = useState<"verify" | "download" | null>(null);
  const [verified, setVerified] = useState<VerifyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const run = async (what: "verify" | "download", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setForbidden(isBomForbidden(e));
      setError(bomRefusalText(e));
    } finally {
      setBusy(null);
    }
  };
  const blocked = exportUnavailableText(verified?.capabilities);
  return (
    <Card
      title={`Snapshot version ${snapshot.version}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className={v.stack} data-testid="bom-snapshot-detail">
        <p>
          Serial <code className={v.mono}>{snapshot.serialNumber}</code> · signed with key <code className={v.mono}>{snapshot.keyId}</code> · body SHA-256{" "}
          <code className={v.mono}>{snapshot.bodySha256}</code>
        </p>
        {forbidden ? (
          <p role="status">{error}</p>
        ) : (
          <>
            <div className={v.row}>
              <Button size="sm" disabled={busy !== null} onClick={() => void run("verify", async () => setVerified(await port.verifySnapshot(snapshot.id)))}>
                {busy === "verify" ? "Verifying…" : "Verify stored snapshot"}
              </Button>
            </div>
            <div className={v.row}>
              <Field label="Download format">
                <Select value={format} disabled={busy !== null} onChange={(e) => setFormat(e.target.value as BomFormat | "all")}>
                  {formats.map((f) => (
                    <option key={f} value={f}>
                      {formatLabel(f)}
                    </option>
                  ))}
                  <option value="all">Every rendered format</option>
                </Select>
              </Field>
              <Button
                size="sm"
                disabled={busy !== null || blocked !== null}
                onClick={() =>
                  void run("download", async () => {
                    const d = await port.downloadSnapshot(snapshot, format);
                    saveBlob(d.blob, d.filename);
                    setNotice(`Saved ${d.filename} (archive SHA-256 ${d.archiveSha256.slice(0, 16)}…, export key ${d.exportKeyId}). The download is audited. Verify it before relying on it.`);
                  })
                }
              >
                {busy === "download" ? "Downloading…" : "Download bundle"}
              </Button>
            </div>
            <p className={v.faint}>Every format comes inside a signed export-bundle/3 with the native body. A format not rendered when the snapshot was taken is never produced afterwards.</p>
            {blocked && <p role="status">{blocked}</p>}
          </>
        )}
        {error && !forbidden && (
          <p className={v.errLine} role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {verified && <VerifyResult result={verified} />}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// the AI BOM tab
// ---------------------------------------------------------------------------

export function AiBomPanel({
  subject,
  metadataPort = bomMetadataApi,
  evidencePort = bomB4Api,
}: {
  subject: BomSubject;
  metadataPort?: BomMetadataPort;
  evidencePort?: BomEvidencePort;
}) {
  const { auth } = useSession();
  const qc = useQueryClient();
  const isAdmin = auth?.isAdmin === true;
  const listKey = ["bom", "snapshots", subject.kind, subject.id];
  const list = useQuery({ queryKey: listKey, queryFn: () => metadataPort.list(subject), enabled: isAdmin, retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDrift, setShowDrift] = useState(false);

  if (!isAdmin) {
    return (
      <div className={v.stack}>
        <Card title="AI BOM">
          <p>The snapshot list, on-demand snapshots and drift are for administrators. If you hold an auditor grant, you can still verify a bundle you were given.</p>
        </Card>
        <BomVerifyPanel evidencePort={evidencePort} />
      </div>
    );
  }

  const take = async () => {
    if (taking) return;
    setTaking(true);
    setTakeError(null);
    setNotice(null);
    try {
      const made = await metadataPort.create(subject);
      setConfirming(false);
      setNotice(`Snapshot version ${made.version} signed and stored (body SHA-256 ${made.bodySha256.slice(0, 16)}…).`);
      await qc.invalidateQueries({ queryKey: listKey });
      setSelected(made.id);
    } catch (e) {
      setTakeError(bomRefusalText(e));
    } finally {
      setTaking(false);
    }
  };

  const snapshot = list.data?.snapshots.find((s) => s.id === selected) ?? null;
  return (
    <div className={v.stack} data-testid="ai-bom-panel">
      <Card
        title="AI BOM snapshots"
        actions={
          <div className={v.row}>
            <Button size="sm" variant="ghost" onClick={() => setShowDrift((d) => !d)} aria-expanded={showDrift}>
              {showDrift ? "Hide drift" : "Check drift"}
            </Button>
            <Button
              size="sm"
              disabled={!list.data?.released || taking}
              onClick={() => {
                setTakeError(null);
                setConfirming(true);
              }}
            >
              Take snapshot
            </Button>
          </div>
        }
      >
        <div className={v.stack}>
          <p className={v.faint}>
            A signed snapshot freezes this subject&rsquo;s models, prompts, tools, datasets and evidence as identifiers and digests. Sign-offs take one
            automatically; you can take one on demand. Listing, snapshots and downloads are audited.
          </p>
          {list.data && !list.data.released && <p role="status">Signed AI BOM snapshots are not released on this gateway. Existing snapshots stay readable.</p>}
          {notice && <p role="status">{notice}</p>}
          {takeError && !confirming && (
            <p className={v.errLine} role="alert">
              {takeError}
            </p>
          )}
          <Table
            rows={list.data?.snapshots ? [...list.data.snapshots].reverse() : undefined}
            rowKey={(s) => s.id}
            loading={list.isLoading}
            error={list.error ? new Error(bomRefusalText(list.error)) : undefined}
            onRetry={() => void list.refetch()}
            empty={<EmptyState title="No snapshots yet" body="No signed AI BOM snapshot has been taken of this subject." />}
            columns={[
              { key: "version", header: "Version", render: (s) => s.version },
              { key: "trigger", header: "Taken by", render: (s) => triggerLabel(s.trigger) },
              { key: "at", header: "When", render: (s) => <span title={s.createdAt}>{shownTime(s.createdAt)}</span> },
              { key: "formats", header: "Formats", render: (s) => downloadableFormats(s).map(formatLabel).join(", ") },
              { key: "digest", header: "Body SHA-256", render: (s) => <Digest value={s.bodySha256} /> },
              {
                key: "open",
                header: "",
                render: (s) => (
                  <Button size="sm" variant="ghost" aria-label={`Open snapshot version ${s.version}`} onClick={() => setSelected(s.id)}>
                    Open
                  </Button>
                ),
              },
            ]}
          />
        </div>
      </Card>
      <Modal
        open={confirming}
        title="Take a signed AI BOM snapshot?"
        onClose={() => {
          if (!taking) setConfirming(false);
        }}
        actions={
          <>
            <Button disabled={taking} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={taking} onClick={() => void take()}>
              {taking ? "Signing…" : "Take snapshot"}
            </Button>
          </>
        }
      >
        <p>This freezes the current inventory of this {subject.kind.replace(/_/g, " ")} as a new version, signed with the receipt key. Earlier versions are not changed. The snapshot is audited.</p>
        <p>With no usable receipt signing key the gateway refuses, and nothing is stored.</p>
        {takeError && (
          <p className={v.errLine} role="alert">
            {takeError}
          </p>
        )}
      </Modal>
      {snapshot && <SnapshotDetail key={snapshot.id} snapshot={snapshot} port={evidencePort} onClose={() => setSelected(null)} />}
      {showDrift && <DriftView subject={subject} port={metadataPort} />}
      <BomVerifyPanel evidencePort={evidencePort} />
    </div>
  );
}
