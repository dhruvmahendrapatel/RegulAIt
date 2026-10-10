/** Browser-only projection of frozen B4 contract #307 (19b80068).
 * The gateway verifies signatures. This client validates identity, census and transport binding;
 * it never accepts an uploaded key as an independent trust root or renders document prose.
 */
import { api } from "../../../api/client";
import { BOM_FORMATS, DIGEST, UUID, checkedAuditId, subjectPath, type BomCapabilities, type BomEvidencePort, type BomInspection, type BomSnapshot, type BomSubject, type BomVerification } from "./bomModel";
const COMMON=["bundle_manifest_signature","bundle_manifest_files","bundle_subject","bundle_email_scan","body_version","body_schema","body_signature"];
const DECISION=["receipt_signature","receipt_payload_hash","receipt_facts_binding","facts_addenda_chain","facts_addenda_signatures","sections_projection","chain_links","decision_content_binding","anchor_record","anchor_imprint","tsa_token","finality","ai_bom_link"];
const AI=["rendering_hashes","serial_number","supersedes"];
const SECTIONS=["decision","receipt","principal","actors","action","policy","model","approval","outcome","cost","trace","proof"];
const FINALITY=["anchored","anchored_finite_lock","anchored_unverified_destination","chain_signed"];
const LIMITS=["nothing_omitted_after_anchor","facts_true","signing_time_beyond_anchor","destination_tamper_resistant","decision_row_content","commitment_after_retain_until","facts_recorded_at_decision_time","finite_lock_under_unbounded_retention"];
const INVALID=["signature_mismatch","unknown_key","unknown_body_version","schema_violation","hash_mismatch","manifest_mismatch","subject_mismatch","facts_hash_mismatch","v1_receipt_after_boundary","addendum_chain_break","section_mismatch","chain_break","anchor_record_incomplete","anchor_mismatch","timestamp_invalid","rendering_not_in_body","serial_mismatch","supersedes_mismatch","bom_link_mismatch","email_shape","bundle_unreadable"];
const UNVERIFIABLE=["preimage_not_exported","receipt_v1_no_factsHash","request_facts_not_recorded","no_timestamp_token","no_tsa_trust_bundle","anchor_absent","snapshot_not_in_bundle","earlier_snapshot_not_in_bundle","rendering_not_producible","not_a_bundle"];
const NOT_RECORDED=["pre_identity","pre_facts","capture_off","no_bound_row","unsigned_addendum","not_captured_by_path","anchor_absent"];
const fail=():never=>{throw new Error("BOM evidence is unavailable or inconsistent.");};
const obj=(v:unknown):Record<string,unknown>=>v!==null && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:fail();
const member=(v:unknown,values:readonly string[]):v is string=>typeof v==="string"&&values.includes(v);
const uuid=(v:unknown):v is string=>typeof v==="string"&&UUID.test(v);
const digest=(v:unknown):v is string=>typeof v==="string"&&DIGEST.test(v);
const positive=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
const time=(v:unknown)=>typeof v==="string"&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const list=(v:unknown,max:number):unknown[]=>Array.isArray(v)&&v.length<=max?v:fail();
const key=(v:unknown)=>typeof v==="string"&&/^[A-Za-z0-9._:-]{1,128}$/.test(v);
export function readB4Capabilities(value:unknown):BomCapabilities {
 const v=obj(value);if(!member(v.access,["admin","auditor_grant"])||!member(v.exportRoles,["admins_only","admins_and_auditors"])||typeof v.canExport!=="boolean"||typeof v.canVerify!=="boolean"||typeof v.canViewDrift!=="boolean"||v.exportRequiresStepUp!==false||!positive(v.rateLimitPerMinute)||v.rateLimitPerMinute>600||!(v.exportUnavailableReason===null||v.exportUnavailableReason==="export_signing_key_absent")||v.canExport!==(v.exportUnavailableReason===null)||v.canViewDrift!==(v.access==="admin"))fail();
 if(v.auditorGrant!==null){const grant=obj(v.auditorGrant);if(!uuid(grant.id)||!uuid(grant.grantedBy)||!time(grant.grantedAt))fail();}
 if(v.access==="auditor_grant"&&(v.auditorGrant===null||v.exportRoles!=="admins_and_auditors"))fail();
 return {canExport:v.canExport as boolean,canVerify:v.canVerify as boolean,canViewDrift:v.canViewDrift as boolean};
}
interface Expected {source:"bundle"|"decision_bom"|"ai_bom_snapshot";auditId?:string;version?:number;snapshot?:BomSnapshot;subject?:BomSubject}
interface Verified {view:BomVerification;inspection:BomInspection;identity:Record<string,unknown>}
export function readB4Verification(value:unknown,expected:Expected):Verified {
 const v=obj(value);
 if(v.identity===null||v.bodyVersion===null){
  if(expected.source!=="bundle"||v.source!=="bundle"||v.trust!=="deployment_registry"||v.identity!==null||v.bodyVersion!==null||v.manifest!==null||v.outcome!=="invalid"||!time(v.verifiedAt)||list(v.sections,12).length||list(v.cannotProve,8).length)fail();
  const checks=list(v.checks,4096).map(value=>{const c=obj(value);if(!member(c.check,[...COMMON,...DECISION,...AI])||c.status!=="invalid"||c.reason!=="bundle_unreadable"||c.ref!==null)fail();return {section:c.check as string,status:"invalid" as const};});if(!checks.length)fail();
  const capabilities=readB4Capabilities(v.capabilities);return {identity:{},view:{trust:"deployment_keys",sections:checks,cannotProve:[]},inspection:{state:"not_recorded",digest:null,finality:null,completeness:[],cannotProve:[],checks,capabilities}};
 }
 const id=obj(v.identity);const decision=id.subject==="decision-bom";
 if(v.trust!=="deployment_registry"||v.source!==expected.source||!member(id.subject,["decision-bom","ai-bom"])||v.bodyVersion!==(decision?"regulait.decision-bom.v1":"regulait.ai-bom.v1")||!positive(id.version)||!time(v.verifiedAt))fail();
 if(decision){if(!uuid(id.auditId)||!uuid(id.bomId)||!member(id.recordedFinality,FINALITY)||!member(id.reportedFinality,[...FINALITY,"anchored_lapsed"])||!member(id.receiptPayloadVersion,["v1","v2"])||!(id.reportedFinality===id.recordedFinality||id.reportedFinality==="anchored_lapsed"&&member(id.recordedFinality,["anchored","anchored_finite_lock"])))fail();}
 else {if(!uuid(id.snapshotId)||!uuid(id.subjectId)||!member(id.subjectKind,["use_case","agent","builder_agent","install"])||typeof id.serialNumber!=="string"||!id.serialNumber.startsWith("urn:uuid:")||!uuid(id.serialNumber.slice(9)))fail();}
 if(expected.source==="decision_bom"&&(!decision||id.auditId!==expected.auditId||expected.version!==undefined&&id.version!==expected.version))fail();
 if(expected.source==="ai_bom_snapshot"&&(decision||!expected.snapshot||!expected.subject||id.snapshotId!==expected.snapshot.id||id.version!==expected.snapshot.version||id.serialNumber!==expected.snapshot.serialNumber||id.subjectKind!==expected.subject.kind||id.subjectId!==expected.subject.id))fail();
 if(expected.source!=="bundle"&&v.manifest!==null)fail();
 if(expected.source==="bundle")validateManifest(v.manifest,id);
 const allowed=[...COMMON,...(decision?DECISION:AI)];const rows=list(v.checks,4096).map(value=>{const c=obj(value);if(!member(c.check,allowed)||!member(c.status,["valid","invalid","unverifiable"])||!(c.ref===null||typeof c.ref==="string"&&/^[A-Za-z0-9._:/-]{1,256}$/.test(c.ref))||!(c.status==="valid"?c.reason===null:member(c.reason,c.status==="invalid"?INVALID:UNVERIFIABLE)))fail();return c;});
 if(allowed.some(name=>!rows.some(c=>c.check===name)))fail();
 if(expected.source!=="bundle"&&rows.some(c=>COMMON.slice(0,4).includes(c.check as string)&&(c.status!=="unverifiable"||c.reason!=="not_a_bundle")))fail();
 if(decision&&rows.some(c=>c.check==="decision_content_binding"&&(c.status!=="unverifiable"||c.reason!=="preimage_not_exported")))fail();
 if(decision&&id.receiptPayloadVersion==="v1"&&rows.some(c=>c.check==="receipt_facts_binding"&&(c.status==="valid"||c.status==="unverifiable"&&c.reason!=="receipt_v1_no_factsHash")))fail();
 const sections=list(v.sections,12).map(value=>{const s=obj(value);if(!member(s.section,SECTIONS)||!member(s.status,["valid","invalid","unverifiable"])||!member(s.completeness,["recorded","not_recorded","not_applicable"])||!(s.notRecordedReason===null||member(s.notRecordedReason,NOT_RECORDED))||(s.completeness==="not_recorded")!==(s.notRecordedReason!==null))fail();return s;});
 if(decision?sections.map(s=>s.section).join()!==SECTIONS.join():sections.length!==0)fail();
 if(sections.some(s=>s.status==="invalid")&&!rows.some(c=>c.check==="sections_projection"&&c.status==="invalid")||sections.some(s=>s.status==="unverifiable")&&rows.some(c=>c.check==="sections_projection"&&c.status==="valid"))fail();
 const outcome=rows.some(c=>c.status==="invalid")?"invalid":rows.some(c=>c.status==="unverifiable")?"valid_with_unverifiable":"valid";
 if(v.outcome!==outcome||sections.some(s=>s.status==="invalid")&&outcome!=="invalid"||sections.some(s=>s.status==="unverifiable")&&outcome==="valid")fail();
 const limits=list(v.cannotProve,8);if(limits.some(l=>!member(l,LIMITS))||new Set(limits).size!==limits.length)fail();
 const required=decision?LIMITS.slice(0,5):["facts_true","signing_time_beyond_anchor"];
 if(decision&&id.reportedFinality==="anchored_lapsed")required.push("commitment_after_retain_until");if(decision&&id.recordedFinality==="anchored_finite_lock")required.push("finite_lock_under_unbounded_retention");if(decision&&id.receiptPayloadVersion==="v1")required.push("facts_recorded_at_decision_time");if(required.some(l=>!limits.includes(l)))fail();
 const checks=allowed.map(check=>{const statuses=rows.filter(c=>c.check===check).map(c=>c.status);return {section:check,status:(statuses.includes("invalid")?"invalid":statuses.includes("unverifiable")?"unverifiable":"valid") as "valid"|"invalid"|"unverifiable"};});
 const capabilities=readB4Capabilities(v.capabilities),cannotProve=limits as string[];
 return {identity:id,view:{trust:"deployment_keys",sections:checks,cannotProve},inspection:{state:outcome==="invalid"?"not_recorded":"ready",digest:expected.snapshot?.bodySha256??null,finality:decision?id.reportedFinality as string:null,completeness:sections.map(s=>({section:s.section as string,status:s.completeness as "recorded"|"not_recorded"|"not_applicable",reason:s.notRecordedReason as string|null})),cannotProve,capabilities,checks}};
}
function validateManifest(value:unknown,id:Record<string,unknown>) {
 const m=obj(value),s=obj(m.subject),d=obj(s.descriptor);if(!(m.installId===null||typeof m.installId==="string"&&m.installId.length>=1&&m.installId.length<=256)||!member(m.installIdSource,["operator","license","absent"]))fail();
 if(m.schema!=="regulait.export-bundle/3"||m.product!=="regulait"||m.exportedAtSource!=="database"||!time(m.exportedAt)||!uuid(m.exportedByUserId)||!key(m.signingKeyId)||typeof m.signingKeyFingerprint!=="string"||!/^sha256:[0-9a-f]{64}$/.test(m.signingKeyFingerprint)||s.kind!==id.subject||!uuid(s.id))fail();
 if(id.subject==="decision-bom"){if(s.id!==id.auditId||d.bomId!==id.bomId||d.auditId!==id.auditId||d.version!==id.version||d.finality!==id.recordedFinality||!positive(d.receiptSeq)||!digest(d.bodySha256)||!(d.aiBomSnapshotId===null||uuid(d.aiBomSnapshotId)))fail();const a=obj(m.audit);if(a.payloadScope!=="none"||!positive(a.segmentFromSeq)||!positive(a.segmentToSeq)||!positive(a.segmentRowCount)||a.segmentToSeq<a.segmentFromSeq||a.segmentRowCount!==a.segmentToSeq-a.segmentFromSeq+1)fail();}
 else if(s.id!==id.snapshotId||d.snapshotId!==id.snapshotId||d.subjectKind!==id.subjectKind||d.subjectId!==id.subjectId||d.version!==id.version||d.serialNumber!==id.serialNumber||!digest(d.bodySha256)||!member(d.trigger,["on_demand","use_case_approval","model_card_approval","prompt_promotion","evidence_attached","config_promotion","server_admission","skill_admission"])||m.audit!==null)fail();
 const formats=list(d.formats,8);if((id.subject!=="decision-bom"&&!formats.length)||formats.some(f=>!member(f,id.subject==="decision-bom"?["cyclonedx-1.7","cyclonedx-1.6","spdx-3.0.1","in-toto"]:BOM_FORMATS))||new Set(formats).size!==formats.length)fail();
 const files=list(m.files,64).map(v=>{const f=obj(v);if(typeof f.path!=="string"||!f.path.length||f.path.length>256||!/^[A-Za-z0-9]/.test(f.path)||! /^[A-Za-z0-9._/-]+$/.test(f.path)||f.path.startsWith("/")||f.path.split("/").some(p=>p===".."||p==="."||p==="")||f.path.startsWith("audit/rows")||!digest(f.sha256))fail();return f.path as string;});if(!files.length||files.some((f,i)=>i>0&&f<=files[i-1]!))fail();
}
export async function sha256(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes as Uint8Array<ArrayBuffer>))).map(n=>n.toString(16).padStart(2,"0")).join("");}
export async function readB4Bundle(blob:Blob,headers:Headers,subject:"ai-bom"|"decision-bom",bodyDigest:string):Promise<Blob>{
 if((headers.get("content-disposition")?.length??257)>256||headers.get("content-type")!=="application/gzip"||headers.get("x-regulait-bundle-schema")!=="regulait.export-bundle/3"||headers.get("x-regulait-bundle-subject")!==subject||!digest(bodyDigest)||headers.get("x-regulait-bom-body-sha256")!==bodyDigest||!digest(headers.get("x-regulait-bundle-sha256"))||!digest(headers.get("x-regulait-bundle-manifest-sha256"))||!key(headers.get("x-regulait-export-signing-key-id"))||!/^sha256:[0-9a-f]{64}$/.test(headers.get("x-regulait-export-signing-key-fingerprint")??"")||!/^attachment; filename="regulait-[A-Za-z0-9._-]+\.tar\.gz"$/.test(headers.get("content-disposition")??""))fail();
 const bytes=new Uint8Array(await blob.arrayBuffer());if(bytes.length<2||bytes[0]!==0x1f||bytes[1]!==0x8b||await sha256(bytes)!==headers.get("x-regulait-bundle-sha256"))fail();return blob;
}
function canonical(value:unknown):string {if(typeof value==="string"&&/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))fail();if(value===null||typeof value!=="object")return JSON.stringify(value)??fail();if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";const v=obj(value);return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";}
export async function readB4Decision(value:unknown,auditId:string,version?:number):Promise<BomInspection>{
 const v=obj(value),b=obj(v.bom),d=obj(v.document),basis=obj(d.basis);if(v.auditId!==auditId||!uuid(b.id)||!positive(b.version)||version!==undefined&&b.version!==version||!(b.supersedes===null||uuid(b.supersedes))||(b.version===1)!==(b.supersedes===null)||!member(b.finality,FINALITY)||!digest(b.bodySha256)||!key(b.keyId)||!time(b.createdAt)||typeof b.body!=="string"||b.body.length>16*1024*1024||typeof b.signature!=="string"||! /^[A-Za-z0-9_-]{86}$/.test(b.signature)||!(b.aiBomSnapshotId===null||uuid(b.aiBomSnapshotId)))fail();
 if(d.v!=="regulait.decision-bom.v1"||d.id!==b.id||d.auditId!==auditId||d.version!==b.version||d.supersedes!==b.supersedes||d.finality!==b.finality||basis.aiBomSnapshotId!==b.aiBomSnapshotId||canonical(d)!==b.body||await sha256(new TextEncoder().encode(b.body))!==b.bodySha256)fail();
 if(!(b.reportedFinality===b.finality||b.reportedFinality==="anchored_lapsed"&&member(b.finality,["anchored","anchored_finite_lock"])))fail();
 const versions=list(v.versions,1024).map(value=>{const r=obj(value);if(!uuid(r.id)||!positive(r.version)||!(r.supersedes===null||uuid(r.supersedes))||(r.version===1)!==(r.supersedes===null)||!digest(r.bodySha256)||!key(r.keyId)||!time(r.createdAt)||!member(r.finality,FINALITY))fail();return r;});if(!versions.length||versions.some((r,i)=>i>0&&Number(r.version)<=Number(versions[i-1]!.version))||!versions.some(r=>r.id===b.id&&r.version===b.version&&r.bodySha256===b.bodySha256&&r.finality===b.finality&&r.supersedes===b.supersedes))fail();
 const bundle=obj(v.bundle);if(bundle.schema!=="regulait.export-bundle/3"||bundle.subject!=="decision-bom"||typeof bundle.href!=="string"||!/^\/v1\/[A-Za-z0-9._~/?=&%-]+$/.test(bundle.href))fail();list(v.renderings,8).forEach(f=>{if(!member(f,["cyclonedx-1.7","cyclonedx-1.6","spdx-3.0.1","in-toto"]))fail();});
 const c=obj(d.completeness);const completeness=SECTIONS.map(section=>{const r=obj(c[section]);if(!member(r.status,["recorded","not_recorded","not_applicable"])||!(r.reason===undefined||member(r.reason,NOT_RECORDED))||(r.status==="not_recorded")!==(r.reason!==undefined))fail();return {section,status:r.status as "recorded"|"not_recorded"|"not_applicable",reason:(r.reason??null) as string|null};});
 return {digest:b.bodySha256 as string,state:"ready",finality:b.reportedFinality as string,completeness,cannotProve:[],capabilities:readB4Capabilities(v.capabilities),decisionMetadata:{auditId,bomId:b.id as string,version:b.version as number,versions:versions.map(r=>r.version as number)}};
}
const query=(version?:number)=>version===undefined?"":"?version="+(positive(version)?version:fail());
const snapshotContext=(id:string,snapshot?:BomSnapshot,subject?:BomSubject)=>{if(!uuid(id)||!snapshot||snapshot.id!==id||!digest(snapshot.bodySha256)||!subject)fail();subjectPath(subject!);return {snapshot:snapshot!,subject:subject!};};
export const bomB4Api:BomEvidencePort={
 exportAllowed:true,
 async inspectSnapshot(id,snapshot,subject){const context=snapshotContext(id,snapshot,subject);return readB4Verification(await api.post("/v1/boms/verify",{source:"ai_bom_snapshot",snapshotId:id}),{source:"ai_bom_snapshot",...context}).inspection;},
 async exportSnapshot(id,format,snapshot,subject){snapshotContext(id,snapshot,subject);if(!member(format,BOM_FORMATS)||format!=="native"&&!snapshot!.formats.includes(format))fail();const res=await api.getBlobWithHeaders(`/v1/ai-bom/snapshots/${id}?format=${format}`);return readB4Bundle(res.body,res.headers,"ai-bom",snapshot!.bodySha256);},
 async decision(auditId,version){checkedAuditId(auditId);const inspection=await readB4Decision(await api.get(`/v1/decisions/${auditId}/bom${query(version)}`),auditId,version);const frozen=inspection.decisionMetadata!.version;const checked=readB4Verification(await api.post("/v1/boms/verify",{source:"decision_bom",auditId,version:frozen}),{source:"decision_bom",auditId,version:frozen});if(checked.identity.bomId!==inspection.decisionMetadata!.bomId||checked.inspection.finality!==inspection.finality||canonical(checked.inspection.completeness)!==canonical(inspection.completeness))fail();return {...inspection,state:checked.inspection.state,cannotProve:checked.inspection.cannotProve,checks:checked.inspection.checks,capabilities:{canExport:inspection.capabilities!.canExport&&checked.inspection.capabilities!.canExport,canVerify:inspection.capabilities!.canVerify&&checked.inspection.capabilities!.canVerify,canViewDrift:inspection.capabilities!.canViewDrift&&checked.inspection.capabilities!.canViewDrift}};},
 async exportDecision(auditId,inspection){checkedAuditId(auditId);if(!inspection?.decisionMetadata||inspection.decisionMetadata.auditId!==auditId||inspection.state!=="ready"||!inspection.capabilities?.canExport||!digest(inspection.digest))fail();const res=await api.getBlobWithHeaders(`/v1/decisions/${auditId}/bom/bundle${query(inspection!.decisionMetadata!.version)}`);return readB4Bundle(res.body,res.headers,"decision-bom",inspection!.digest!);},
 async verify(bundle){if(bundle.size===0||bundle.size>8*1024*1024)fail();const bytes=new Uint8Array(await bundle.arrayBuffer());let binary="";for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return readB4Verification(await api.post("/v1/boms/verify",{source:"bundle",bundleBase64:btoa(binary)}),{source:"bundle"}).view;},
};
