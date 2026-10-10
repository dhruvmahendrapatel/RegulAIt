import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../../session/SessionContext";
import { Button, Card } from "../../../ui/kit";
import { BomAssurance, BomOfflineInstructions, BomVerifyPanel } from "./BomEvidencePanel";
import { bomPortKey, checkedAuditId, downloadBom, readInspection, type BomEvidencePort } from "./bomModel";
import v from "../../views.module.css";
export function DecisionBomPanel({ auditId, evidencePort }: { auditId: string; evidencePort?: BomEvidencePort }) {
  const {auth}=useSession();
  const valid = (() => {try {checkedAuditId(auditId);return true;} catch {return false;}})();
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  useEffect(()=>{setError(null);setNotice(null);},[auditId,evidencePort,auth?.userId]);
  const view=useQuery({queryKey:["bom","decision",auditId,bomPortKey(evidencePort),auth?.userId ?? "no-account"],queryFn:async()=>readInspection(await evidencePort!.decision(auditId)),enabled:valid&&Boolean(evidencePort),retry:false});
  return <div className={v.stack}><Card title="Decision BOM"><p>Historical decision evidence uses recorded identifiers, classifications and digests. It never substitutes today's state or includes display names, prompt content or model output.</p>
    {!valid ? <p role="alert">Choose a valid decision audit ID.</p> : <><p>Decision audit ID: <code>{auditId}</code></p>
      {!evidencePort ? <p>Decision BOM evidence and bundle downloads are unavailable on this gateway. No completeness or verification result has been established.</p> : <>
        {view.isLoading&&<p role="status">Reading decision evidence…</p>}{view.error&&<p role="alert">Decision evidence is unavailable or pending. <Button onClick={()=>void view.refetch()}>Retry decision evidence</Button></p>}{view.data&&!view.error&&!view.isFetching&&<BomAssurance inspection={view.data}/>}
        <p>Downloads are audited verifiable bundles. Export permission requires an administrator or an explicit auditor grant.</p>
        <Button disabled={busy||!evidencePort.exportAllowed||view.data?.state!=="ready"||Boolean(view.error)||view.isFetching} onClick={()=>{const capturedId=auditId;setBusy(true);setError(null);setNotice(null);void evidencePort.exportDecision(capturedId).then(blob=>{downloadBom(blob,`decision-bom-${capturedId}.zip`);setNotice("Verifiable decision bundle downloaded.");}).catch(()=>setError("Decision bundle export was refused or is unavailable.")).finally(()=>setBusy(false));}}>Download Decision BOM bundle</Button>
      </>}
    </>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <BomOfflineInstructions />
  </Card><BomVerifyPanel evidencePort={evidencePort}/></div>;
}
