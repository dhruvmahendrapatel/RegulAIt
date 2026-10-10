import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Modal, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { useSession } from "../../../session/SessionContext";
import { bomMetadataApi, type BomMetadataPort } from "./bomApi";
import { BOM_FORMATS, bomPortKey, downloadBom, finalityLabel, formatLabel, readInspection, readVerification, recordedTime, safeLimit, safeReason, safeSection, type BomEvidencePort, type BomFormat, type BomInspection, type BomSubject } from "./bomModel";
import { bomB4Api } from "./bomB4Api";
import v from "../../views.module.css";

export function BomAssurance({ inspection }: { inspection: BomInspection }) {
  return <div className={v.stack}>
    <p><Badge tone={inspection.state === "ready" ? "info" : "warn"}>{inspection.state === "ready" ? "Recorded evidence" : inspection.state === "pending" ? "Pending evidence" : "Not recorded"}</Badge></p>
    {inspection.digest && <p>Native body SHA-256: <code>{inspection.digest}</code></p>}
    <p>{finalityLabel(inspection.finality)}</p>
    {inspection.completeness.length ? <ul>{inspection.completeness.map((row, i) => <li key={i}>{safeSection(row.section)}: <Badge tone={row.status === "not_recorded" ? "warn" : "neutral"}>{row.status === "recorded" ? "Recorded" : row.status === "not_applicable" ? "Not applicable" : "Not recorded"}</Badge>{row.reason !== null && <> — {safeReason(row.reason)}</>}</li>)}</ul> : <p>Section completeness is unmeasured.</p>}
    {inspection.checks && <ul>{inspection.checks.map(row=><li key={row.section}>{safeSection(row.section)}: <Badge tone={row.status === "invalid" ? "danger" : row.status === "unverifiable" ? "warn" : "info"}>{row.status === "valid" ? "Valid" : row.status === "invalid" ? "Invalid" : "Unverifiable"}</Badge></li>)}</ul>}
    <p>A signature alone does not establish completeness or that a model's declarations are true.</p>
    {inspection.cannotProve.length > 0 && <><p>What this evidence cannot prove:</p><ul>{inspection.cannotProve.map((limit, i) => <li key={i}>{safeLimit(limit)}</li>)}</ul></>}
  </div>;
}

export function BomVerifyPanel({ evidencePort = bomB4Api, canVerify }: { evidencePort?: BomEvidencePort | null; canVerify?:boolean }) {
  const {auth}=useSession();
  const version = useRef(0);
  const [denied,setDenied]=useState(false);
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<Blob | null>(null), [result, setResult] = useState<ReturnType<typeof readVerification> | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { version.current++; setBundle(null);setResult(null);setError(null);setReading(false);setDenied(false); return () => {version.current++;}; }, [evidencePort,auth?.userId]);
  return <Card title="Verify a BOM bundle">
    <p>Online verification uses this deployment's recorded public keys. A key included in an uploaded bundle does not establish who signed it.</p>
    {!evidencePort && <p>Online BOM verification is unavailable on this gateway.</p>}
    <Field label="BOM bundle to verify" help="Choose a BOM tar.gz bundle up to 8 MiB. Its contents are never displayed."><Input type="file" accept=".tar.gz,.gz,application/gzip" disabled={!evidencePort || busy || denied || canVerify===false} onChange={event => {
      const current = ++version.current; setReading(false); setBundle(null); setResult(null); setError(null);
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) { setError("Choose a BOM bundle no larger than 8 MiB."); return; }
      setReading(true);
      void file.arrayBuffer().then(bytes => { if (version.current !== current) return; setBundle(new Blob([bytes], {type:file.type || "application/octet-stream"})); }).catch(() => { if (version.current === current) setError("The BOM file could not be read."); }).finally(() => { if (version.current === current) setReading(false); });
    }} /></Field>
    {!denied && canVerify!==false && <Button disabled={!evidencePort || busy || reading || bundle === null} onClick={() => { if(!bundle||!evidencePort)return;const captured = bundle, current = version.current; setBusy(true); setResult(null); setError(null); void evidencePort!.verify(captured).then(value => { if (current === version.current) setResult(readVerification(value)); }).catch((cause:unknown) => { if (current === version.current) {if(isBomForbidden(cause))setDenied(true);setError("BOM verification is unavailable. No verification result was established.");} }).finally(() => setBusy(false)); }}>Verify loaded BOM bundle</Button>}
    {error && <p role="alert">{error}</p>}
    {result && <div role="status"><p>{result.trust === "deployment_keys" ? "Trust root: this deployment's recorded keys." : "Trust root: independently pinned keys."}</p>
      {result.sections.length ? <ul>{result.sections.map((row, i) => <li key={i}>{safeSection(row.section)}: <Badge tone={row.status === "invalid" ? "danger" : row.status === "unverifiable" ? "warn" : "info"}>{row.status === "valid" ? "Valid" : row.status === "invalid" ? "Invalid" : "Unverifiable"}</Badge></li>)}</ul> : <p>No sections were verified. This is not a completeness finding.</p>}
      <ul>{result.cannotProve.map((limit, i) => <li key={i}>{safeLimit(limit)}</li>)}</ul>
    </div>}
    <BomOfflineInstructions />
  </Card>;
}

export function BomOfflineInstructions() {
  return <div><p>Offline verification requires the deployment's BOM verifier and public-key fingerprints or a keyring obtained independently of the bundle. Keep the exact downloaded bundle bytes.</p>
    <p>Check the archive manifest, signed native body, rendering digests, receipt binding and available audit/anchor proofs. Supply the trusted TSA certificates separately when checking a timestamp. An absent or unverifiable section stays unmeasured.</p>
    <p>A key or certificate supplied only by the bundle does not establish a trusted signer. Do not use a passing signature to claim that omitted history or model declarations were verified.</p></div>;
}

export function AiBomPanel({ subject, metadataPort = bomMetadataApi, evidencePort = bomB4Api }: { subject: BomSubject; metadataPort?: BomMetadataPort; evidencePort?: BomEvidencePort | null }) {
  const { auth } = useSession(); const queryClient = useQueryClient();
  const flight = useRef(false), generation=useRef(0);
  const [exportDenied,setExportDenied]=useState(false);
  useEffect(()=>{generation.current++;return()=>{generation.current++;};},[subject.kind,subject.id,evidencePort,auth?.userId]);
  const fixture = metadataPort !== bomMetadataApi;
  const canRead = fixture || auth?.isAdmin === true;
  const key = ["bom", "snapshots", subject.kind, subject.id, bomPortKey(metadataPort), auth?.userId ?? "no-account"];
  const list = useQuery({ queryKey: key, queryFn: () => metadataPort.list(subject), enabled: canRead, retry: false });
  const [selected, setSelected] = useState<string | null>(null), [format, setFormat] = useState<BomFormat>("native"), [showDrift, setShowDrift] = useState(false), [confirm, setConfirm] = useState<{subject: BomSubject; key: string[]} | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setExportDenied(false);setSelected(null); setShowDrift(false); setConfirm(null); setError(null); setNotice(null); }, [subject.kind, subject.id, metadataPort, evidencePort, auth?.userId, canRead]);
  const snapshot = list.data?.snapshots.find(row => row.id === selected);
  const inspection = useQuery({ queryKey: ["bom", "inspection", subject.kind,subject.id, selected, snapshot?.bodySha256, bomPortKey(evidencePort), auth?.userId ?? "no-account"], queryFn: async () => {const value=readInspection(await evidencePort!.inspectSnapshot(selected!,snapshot,subject)); if(value.state === "ready" && value.digest !== snapshot?.bodySha256) throw new Error("Snapshot digest binding is unavailable."); return value;}, enabled: Boolean(canRead && evidencePort && snapshot), retry: false });
  const drift = useQuery({ queryKey: ["bom", "drift", subject.kind, subject.id, bomPortKey(metadataPort), auth?.userId ?? "no-account"], queryFn: () => metadataPort.drift(subject), enabled: showDrift && canRead && Boolean(list.data?.snapshots.length), retry: false });
  const formats = snapshot ? BOM_FORMATS.filter(f => f === "native" || snapshot.formats.includes(f)) : [];
  const run = async (action: () => Promise<void>) => { const current=generation.current;if(flight.current)return;flight.current=true;setBusy(true); setError(null); setNotice(null); try { await action(); } catch { if(current===generation.current)setError("The BOM operation was refused or is unavailable. No new evidence was established."); } finally { flight.current=false;setBusy(false); } };
  return <div className={v.stack}><Card title="AI BOM snapshots">
    <p>A signed snapshot records inventory at capture time. This view displays identifiers and digests; prompt, output, credential and training content are never displayed.</p>
    {!canRead ? <p>BOM evidence access requires an administrator or an explicitly granted auditor. Access has not been established for this account.</p> : <>
      {list.isLoading && <p role="status">Loading snapshot metadata…</p>}
      {list.error && <p role="alert">Snapshot metadata is unavailable. <Button onClick={() => void list.refetch()}>Retry snapshots</Button></p>}
      {list.data && <>
        {!list.data.released && <p>New signed snapshots are unavailable on this gateway. Existing snapshot metadata remains readable.</p>}
        <Button disabled={busy || !list.data.released || Boolean(list.error) || list.isFetching} onClick={() => setConfirm({subject:{...subject},key:[...key]})}>Take signed snapshot</Button>
        <Table rows={list.data.snapshots} rowKey={row => row.id} empty={<EmptyState title="No signed snapshots" body="No snapshot evidence has been recorded for this subject." />} columns={[
          { key: "version", header: "Version", render: row => row.version },
          { key: "time", header: "Captured", render: row => recordedTime(row.createdAt) },
          { key: "digest", header: "Native body SHA-256", render: row => <code>{row.bodySha256}</code> },
          { key: "inspect", header: "Evidence", render: row => <Button disabled={busy} aria-label={`Inspect snapshot version ${row.version}`} onClick={() => {setSelected(row.id);setFormat("native");}}>Inspect snapshot</Button> },
        ]} />
        {list.data.snapshots.length > 0 && <Button disabled={busy || inspection.data?.capabilities?.canViewDrift === false} onClick={() => setShowDrift(value => !value)}>{showDrift ? "Hide inventory drift" : "Check inventory drift"}</Button>}
      </>}
    </>}
    {confirm && <Modal open title="Take signed AI BOM snapshot" onClose={() => {if(!busy)setConfirm(null);}} actions={<><Button disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button><Button disabled={busy} onClick={() => void run(async () => { const intent=confirm!,current=generation.current; await metadataPort.create(intent.subject); if(current!==generation.current)return;setConfirm(null); await queryClient.invalidateQueries({queryKey:intent.key});if(current===generation.current)setNotice("Signed snapshot recorded."); })}>Take snapshot</Button></>}>Freeze a new inventory version. Existing signed versions remain unchanged. Capturing the snapshot is audited and requires a configured signing key.</Modal>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </Card>
  {showDrift && canRead && <Card title="Inventory drift"><p><Badge tone="warn">Not evidence</Badge> This compares live inventory with the latest signed snapshot. It is a change list and cannot be downloaded as a BOM.</p>
    {drift.isLoading && <p role="status">Measuring drift…</p>}{drift.error && <p role="alert">Inventory drift could not be measured. <Button onClick={() => void drift.refetch()}>Retry drift</Button></p>}
    {drift.data && !drift.error && !drift.isFetching && <><p>Baseline snapshot version {drift.data.baseline.version}, captured {recordedTime(drift.data.baseline.createdAt)}.</p>{drift.data.changes.length ? <ul>{drift.data.changes.map((row, i) => <li key={i}>{row.reference}: {row.change.replaceAll("_", " ")}{row.beforeHashes.map(h => <p key={`before-${h}`}>Previous SHA-256: <code>{h}</code></p>)}{row.afterHashes.map(h => <p key={`after-${h}`}>Current SHA-256: <code>{h}</code></p>)}</li>)}</ul> : <p>No inventory changes measured against this baseline. This does not establish completeness.</p>}</>}
  </Card>}
  {snapshot && canRead && <Card title={`Snapshot version ${snapshot.version}`}><p>Serial number: <code>{snapshot.serialNumber}</code></p><p>Native body SHA-256: <code>{snapshot.bodySha256}</code></p>
    {!evidencePort ? <p>Snapshot inspection and verifiable bundle downloads are unavailable on this gateway.</p> : <>
      {inspection.isLoading && <p role="status">Reading recorded assurance…</p>}{inspection.error && <p role="alert">Snapshot assurance is unavailable. <Button onClick={() => void inspection.refetch()}>Retry assurance</Button></p>}{inspection.data && !inspection.error && !inspection.isFetching && <BomAssurance inspection={inspection.data} />}
      <Field label="BOM bundle format"><Select value={format} onChange={event => setFormat(event.target.value as BomFormat)}>{BOM_FORMATS.map(f => <option key={f} value={f} disabled={!formats.includes(f)}>{formatLabel(f)}{!formats.includes(f) ? " — not recorded" : ""}</option>)}</Select></Field>
      <p>Every format is delivered with its signed native body inside a verifiable bundle. Every export is audited. Export permission requires an administrator or an explicit auditor grant.</p>
      {!exportDenied && <Button disabled={busy || !(inspection.data?.capabilities?.canExport ?? evidencePort.exportAllowed) || !formats.includes(format) || inspection.data?.state !== "ready" || Boolean(inspection.error) || inspection.isFetching || inspection.data?.digest !== snapshot.bodySha256} onClick={() => void run(async () => { const capturedId=snapshot.id,capturedFormat=format,current=generation.current; const blob=await evidencePort.exportSnapshot(capturedId,capturedFormat,snapshot,{...subject}).catch((cause:unknown)=>{if(current===generation.current&&isBomForbidden(cause))setExportDenied(true);throw cause;});if(current!==generation.current)return;downloadBom(blob,`ai-bom-${capturedId}-${capturedFormat}.tar.gz`);setNotice("BOM bundle downloaded. Verify its signatures before relying on it."); })}>Download BOM bundle</Button>}
      {!(inspection.data?.capabilities?.canExport ?? evidencePort.exportAllowed) && <p>Export permission has not been established. No download is available.</p>}
    </>}
  </Card>}
  <BomVerifyPanel key={`${subject.kind}:${subject.id}`} evidencePort={evidencePort} canVerify={inspection.data?.capabilities?.canVerify} />
  </div>;
}

export function isBomForbidden(cause:unknown):boolean{return cause!==null && typeof cause==="object" && "status" in cause && cause.status===403;}
