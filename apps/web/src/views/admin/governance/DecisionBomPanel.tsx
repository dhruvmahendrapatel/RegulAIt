import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../../session/SessionContext";
import { Button, Card, Field, Select } from "../../../ui/kit";
import { BomAssurance, isBomForbidden, BomOfflineInstructions, BomVerifyPanel } from "./BomEvidencePanel";
import { bomPortKey, checkedAuditId, downloadBom, readInspection, type BomEvidencePort } from "./bomModel";
import { bomB4Api } from "./bomB4Api";
import v from "../../views.module.css";
export function DecisionBomPanel({ auditId, evidencePort = bomB4Api }: { auditId: string; evidencePort?: BomEvidencePort | null }) {
  const {auth}=useSession();
  const generation=useRef(0);
  const valid = (() => {try {checkedAuditId(auditId);return true;} catch {return false;}})();
  const [selectedVersion,setSelectedVersion]=useState<number|undefined>(undefined);
  useEffect(()=>{generation.current++;return()=>{generation.current++;};},[auditId,evidencePort,auth?.userId,selectedVersion]);
  const [exportDenied,setExportDenied]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  useEffect(()=>{setExportDenied(false);setError(null);setNotice(null);setSelectedVersion(undefined);},[auditId,evidencePort,auth?.userId]);
  const view=useQuery({queryKey:["bom","decision",auditId,selectedVersion,bomPortKey(evidencePort),auth?.userId ?? "no-account"],queryFn:async()=>readInspection(await evidencePort!.decision(auditId,selectedVersion)),enabled:valid&&Boolean(evidencePort),retry:false});
  return <div className={v.stack}><Card title="Decision BOM"><p>Historical decision evidence uses recorded identifiers, classifications and digests. It never substitutes today's state or includes display names, prompt content or model output.</p>
    {!valid ? <p role="alert">Choose a valid decision audit ID.</p> : <><p>Decision audit ID: <code>{auditId}</code></p>
      {!evidencePort ? <p>Decision BOM evidence and bundle downloads are unavailable on this gateway. No completeness or verification result has been established.</p> : <>
        {view.isLoading&&<p role="status">Reading decision evidence…</p>}{view.error&&<p role="alert">Decision evidence is unavailable or pending. <Button onClick={()=>void view.refetch()}>Retry decision evidence</Button></p>}{view.data&&!view.error&&!view.isFetching&&<BomAssurance inspection={view.data}/>}
        {view.data?.decisionMetadata && !view.error && !view.isFetching && <Field label="Decision BOM version"><Select value={view.data.decisionMetadata.version} onChange={event=>{setSelectedVersion(Number(event.target.value));setNotice(null);setError(null);}}>{view.data.decisionMetadata.versions.map(version=><option key={version} value={version}>Version {version}</option>)}</Select></Field>}
        <p>Downloads are audited verifiable bundles. Export permission requires an administrator or an explicit auditor grant.</p>
        {!exportDenied && <Button disabled={busy||!(view.data?.capabilities?.canExport ?? evidencePort.exportAllowed)||view.data?.state!=="ready"||Boolean(view.error)||view.isFetching} onClick={()=>{const capturedId=auditId,current=generation.current;setBusy(true);setError(null);setNotice(null);void evidencePort.exportDecision(capturedId,view.data).then(blob=>{if(current!==generation.current)return;downloadBom(blob,`decision-bom-${capturedId}.tar.gz`);setNotice("Decision bundle downloaded. Verify its signatures before relying on it.");}).catch((cause:unknown)=>{if(current===generation.current){if(isBomForbidden(cause))setExportDenied(true);setError("Decision bundle export was refused or is unavailable.");}}).finally(()=>setBusy(false));}}>Download Decision BOM bundle</Button>}
      </>}
    </>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <BomOfflineInstructions />
  </Card><BomVerifyPanel key={`${auditId}:${selectedVersion ?? "latest"}`} evidencePort={evidencePort} canVerify={view.data?.capabilities?.canVerify}/></div>;
}
