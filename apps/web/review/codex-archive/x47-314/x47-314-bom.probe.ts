import assert from "node:assert/strict";
import { buildAiBom, AI_BOM_RECORD_LISTS, scrubAuditText, decisionBomFinality, validateCycloneDx, bomCanonicalBytes, bomJsonSafeIssues } from "../../../packages/shared/dist/index.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const secret = ["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-"); // synthetic detector-recognised canary
const fixture = () => ({
  ...Object.fromEntries(AI_BOM_RECORD_LISTS.map(k => [k, []])),
  subject:{kind:"use_case",id:id(1)}, install:{installId:null},
  useCases:[{id:id(1),name:"Synthetic review",ownerUserId:null,ownerDisplayName:null,dataSensitivity:"internal",complianceTags:[],euAiActTier:null,status:"approved",intendedAgentIds:[id(2)]}],
  agents:[{id:id(2),name:"Synthetic agent",provider:"mock",model:"synthetic-model",expectedServedModel:null,customProviderId:null,lifecycleStatus:"active",ownerUserId:null,ownerDisplayName:null,workloadIdentity:null,observedLastSeen:null,observedCount:0}],
  modelCards:[{id:id(3),agentId:id(2),customProviderId:null,intendedUse:"Synthetic summaries",limitations:null,biasFairness:[],dataClaims:{},standardRefs:[],pinnedModelVersion:null}],
}) as any;
const meta = {id:id(9),subjectKind:"use_case",subjectId:id(1),version:1,supersedes:null,trigger:"on_demand",createdAt:"2026-10-10T12:00:00.000Z"} as any;
const build = (f:any) => buildAiBom(f,meta,{cyclonedxVersions:["1.7","1.6"]});
let pass=0,fail=0;
function test(name:string,fn:()=>void){try{fn();pass++;console.log(`PASS ${name}`)}catch(e){fail++;console.log(`RED ${name}: ${(e as Error).message}`)}}
const output = (b:any) => [b.bodyBytes,...b.renderings.map((r:any)=>r.bytes)].join("\n");
test("control: secret is recognised by existing scrubber",()=>assert.notEqual(scrubAuditText(secret),secret));
test("control: normal synthetic fixture builds with both offline schemas",()=>{const b=build(fixture());for(const r of b.renderings)assert.equal(validateCycloneDx(JSON.parse(r.bytes),r.format.endsWith("1.6")?"1.6":"1.7").valid,true)});
for(const [list,field] of [["agents","provider"],["agents","model"],["agents","expectedServedModel"],["agents","ownerDisplayName"],["useCases","ownerDisplayName"],["modelCards","pinnedModelVersion"]]){
 test(`secret refused or absent: ${list}.${field}`,()=>{const f=fixture();f[list][0][field]=secret;let b;try{b=build(f)}catch{return}const exposed=[["native",b.bodyBytes],...b.renderings.map(r=>[r.format,r.bytes])].filter(([,bytes])=>bytes.includes(secret)).map(([name])=>name);assert.deepEqual(exposed,[],"recognised credential survived: "+exposed.join(", "))});
}
for(const [list,field] of [["agents","name"],["modelCards","intendedUse"],["modelCards","limitations"]]){
 test(`private URL refused or sanitised: ${list}.${field}`,()=>{const f=fixture();f[list][0][field]="https://internal.example/private-location?signature=SYNTHETIC_QUERY";let b;try{b=build(f)}catch{return}assert.equal(output(b).includes("private-location"),false,"private path survived signed bytes");assert.equal(output(b).includes("SYNTHETIC_QUERY"),false)});
}
test("byte stability across object/list order and rendering version order",()=>{const f=fixture();f.agents.push({...f.agents[0],id:id(4),name:"Second synthetic agent"});f.useCases[0].intendedAgentIds.push(id(4));const a=build(f);const reordered:any=Object.fromEntries(Object.entries(f).reverse().map(([k,v])=>[k,Array.isArray(v)?[...v].reverse():v]));reordered.useCases[0].intendedAgentIds.reverse();const b=buildAiBom(reordered as any,meta,{cyclonedxVersions:["1.6","1.7"]});assert.equal(a.bodyBytes,b.bodyBytes);assert.deepEqual(a.renderings,b.renderings)});
test("control: guarded agent name refuses recognised secret",()=>{const f=fixture();f.agents[0].name=secret;assert.throws(()=>build(f),/credential/)});
test("safe integers/ASCII keys reject fraction and Unicode key",()=>{assert.notEqual(bomJsonSafeIssues({a:1.5}).length,0);assert.notEqual(bomJsonSafeIssues({"é":1}).length,0);assert.equal(bomCanonicalBytes({z:0,a:[true,null,"\n\t\\\"é"]}),'{"a":[true,null,"\\n\\t\\\\\\\"é"],"z":0}')});
const base:any={anchor:{status:"flushed",tamperResistant:true,tsaGranted:true,retainUntil:new Date("2027-01-01Z")},receiptSigned:true,timestampMode:"required",decisionAt:new Date("2026-10-01Z"),retainedDays:null,now:new Date("2026-10-10Z"),setting:"anchored",finiteLock:"refuse"};
test("finite lock refuses strict floor and accepts explicit relaxation",()=>{assert.deepEqual(decisionBomFinality(base),{freeze:false,reason:"retention_unbounded"});assert.deepEqual(decisionBomFinality({...base,finiteLock:"accept"}),{freeze:true,state:"anchored_finite_lock"});assert.deepEqual(decisionBomFinality({...base,receiptSigned:false,finiteLock:"accept"}),{freeze:false,reason:"receipt_unsigned"})});
console.log(JSON.stringify({pass,fail}));process.exitCode=fail?1:0;
