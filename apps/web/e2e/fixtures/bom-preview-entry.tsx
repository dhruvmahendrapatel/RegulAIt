import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "../../src/session/SessionContext";
import { useTheme } from "../../src/ui/useTheme";
import { Button } from "../../src/ui/kit";
import { AiBomPanel } from "../../src/views/admin/governance/BomEvidencePanel";
import { DecisionBomPanel } from "../../src/views/admin/governance/DecisionBomPanel";
import { readSnapshotList, readDrift, type BomEvidencePort, type BomSubject } from "../../src/views/admin/governance/bomModel";
import type { BomMetadataPort } from "../../src/views/admin/governance/bomApi";
import "../../src/theme/tokens.css";
import "../../src/theme/fonts.css";
import "../../src/theme/global.css";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const time="2026-10-10T12:00:00.000Z",digest="a".repeat(64);
const snapshot={id:id(9),version:1,serialNumber:`urn:uuid:${id(9)}`,trigger:"on_demand",bodySha256:digest,keyId:"synthetic-key",createdAt:time,formats:["cyclonedx-1.7","cyclonedx-1.6","spdx-3.0.1"]};
const params=new URLSearchParams(location.search),mode=params.get("mode")||"normal";
const zip="UEsDBBQAAAAAAIyBSl1EK1QxWQAAAFkAAAANAAAATU9DSy1PTkxZLnR4dFN5bnRoZXRpYyBVSSBkaXNwbGF5LXBvcnQgYXJjaGl2ZS4gTm8gc2lnbmF0dXJlIG9yIGNyeXB0b2dyYXBoaWMgZXZpZGVuY2UgaXMgZXN0YWJsaXNoZWQuUEsDBBQAAAAAAIyBSl1OKJLRNgAAADYAAAASAAAAbW9jay1tYW5pZmVzdC5qc29ueyJzY2hlbWEiOiJyZWd1bGFpdC5leHBvcnQtYnVuZGxlLzMiLCJzeW50aGV0aWMiOnRydWV9UEsBAhQDFAAAAAAAjIFKXUQrVDFZAAAAWQAAAA0AAAAAAAAAAAAAAIABAAAAAE1PQ0stT05MWS50eHRQSwECFAMUAAAAAACMgUpdTiiS0TYAAAA2AAAAEgAAAAAAAAAAAAAAgAGEAAAAbW9jay1tYW5pZmVzdC5qc29uUEsFBgAAAAACAAIAewAAAOoAAAAAAA==";
function archive(){return new Blob([Uint8Array.from(atob(zip),c=>c.charCodeAt(0))],{type:"application/zip"})}
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:0}}});
function Preview(){
 const {theme,toggle}=useTheme(),[subject,setSubject]=useState<BomSubject>({kind:"agent",id:id(1)}),[events,setEvents]=useState<string[]>([]);
 const log=(event:string)=>setEvents(old=>[...old,event]);
 // Explicit fixture hook simulates an external subject navigation while a confirmation is open.
 (window as unknown as {switchBomSubject:()=>void}).switchBomSubject=()=>setSubject({kind:"agent",id:id(2)});
 const metadata=useMemo<BomMetadataPort>(()=>({
  list:async s=>{if(mode==="error")throw new Error("SYNTHETIC_SECRET_ERROR");return readSnapshotList({subject:s,released:mode!=="unavailable",snapshots:mode==="empty"?[]:[snapshot]},s)},
  create:async s=>{log(`created ${s.id}`)},
  drift:async s=>readDrift({subject:s,evidence:false,baseline:{snapshotId:id(9),version:1,createdAt:time,serialNumber:snapshot.serialNumber},changes:[{ref:`agent:${id(1)}`,change:"changed_hash",before:{version:"SYNTHETIC_OLD_MODEL",hashes:[`SHA-256:${digest}`]},after:{version:"SYNTHETIC_PRIVATE_VERSION",hashes:[`SHA-256:${"b".repeat(64)}`]}}]},s),
 }),[]);
 const evidence=useMemo<BomEvidencePort>(()=>({
  exportAllowed:mode!=="deny",
  inspectSnapshot:async()=>{if(mode==="inspection-error")throw new Error("SYNTHETIC_INSPECTION_ERROR");return {state:mode==="pending"?"pending":mode==="missing"?"not_recorded":"ready",digest:mode==="mismatch"?"b".repeat(64):digest,finality:mode==="finite"?"anchored_finite_lock":mode==="lapsed"?"anchored_lapsed":"chain_signed",completeness:[{section:mode==="unknown"?"__proto__":"actors",status:"not_recorded",reason:mode==="unknown"?"constructor":"pre_identity"}],cannotProve:[mode==="unknown"?"toString":"model_truth"]}},
  exportSnapshot:async(i,f)=>{log(`snapshot bundle ${f}`);return archive()},
  decision:async()=>({state:mode==="pending"?"pending":"ready",digest,finality:"chain_signed",completeness:[{section:"action",status:"recorded",reason:null},{section:"actors",status:"not_recorded",reason:"pre_identity"}],cannotProve:["model_truth","receipt_binding"]}),
  exportDecision:async()=>{log("decision bundle");return archive()},
  verify:async bundle=>{const value=JSON.parse(await bundle.text());if(!value.synthetic)throw new Error("SYNTHETIC_VERIFY_ERROR");log("verified synthetic bundle");return {trust:"deployment_keys",sections:[{section:"signature",status:"valid"},{section:"actors",status:"unverifiable"}],cannotProve:["model_truth"]}},
 }),[]);
 return <main style={{maxWidth:1100,margin:"auto",padding:"var(--s4)"}}><h1>Synthetic BOM UI preview</h1><p role="note">Mock display ports and synthetic evidence only. Downloads are mock archives; no cryptographic, storage or API acceptance is established.</p>
 <Button onClick={toggle}>Switch to {theme==="dark"?"light":"dark"} theme</Button><Button onClick={()=>setSubject({kind:"agent",id:subject.id===id(1)?id(2):id(1)})}>Switch subject</Button>
 <AiBomPanel subject={subject} metadataPort={mode==="api"?undefined:metadata} evidencePort={mode==="unavailable"||mode==="api"?undefined:evidence}/>
 <DecisionBomPanel auditId={id(7)} evidencePort={mode==="unavailable"||mode==="api"?undefined:evidence}/>
 <section aria-label="Synthetic operation log"><h2>Synthetic operation log</h2><ul>{events.map((event,i)=><li key={i}>{event}</li>)}</ul></section></main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><SessionProvider><Preview/></SessionProvider></QueryClientProvider>);
