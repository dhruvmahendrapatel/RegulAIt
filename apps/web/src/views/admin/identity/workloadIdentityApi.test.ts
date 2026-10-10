import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { encodeIdentityWrite as encodeIdentityWriteRequest, identityReadRequests, sendIdentityWrite } from "./workloadIdentityApi";
import type { IdentityWrite, OwnGrant } from "./workloadIdentityModel";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const identityId = U(1), subjectId = U(2), stewardIds = [U(3)], environments = ["demo"];
const publicKey = { kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
const notAfter = "2026-10-11T00:00:00Z";
const grant = (overrides: Partial<OwnGrant> = {}): OwnGrant => ({ id: U(9), kind: "tool", targetId: U(8), targetName: "Synthetic server", toolName: "read_record", access: "read", ...overrides });
const add = (kind: OwnGrant["kind"], fields: Record<string,unknown> = {}): IdentityWrite => ({ operation:"add_grant", identityId, kind, targetId:U(7), toolName:null, access:null, ...fields } as IdentityWrite);
const encodeIdentityWrite = (command: IdentityWrite, grants?: readonly OwnGrant[]) => encodeIdentityWriteRequest(command, grants, grants === undefined ? undefined : 0);
afterEach(()=>vi.restoreAllMocks());
describe("accepted workload identity write contract",()=>{
  it.each([ ["agent","agentId"], ["builder_agent","builderAgentId"], ["engine_runner","engineRunnerId"] ] as const)("maps %s to only its exact subject",(kind,field)=>{
    expect(encodeIdentityWrite({operation:"create_identity",kind,subjectId,stewardIds,environments})).toEqual({method:"POST",path:"/v1/workload-identities",body:{kind,[field]:subjectId,sponsorUserIds:stewardIds,environments}});
  });
  it.each(["worker_runtime","pdp"] as const)("maps %s without internal subject",kind=>{
    expect(encodeIdentityWrite({operation:"create_identity",kind,subjectId:null,stewardIds,environments}).body).toEqual({kind,sponsorUserIds:stewardIds,environments});
    expect(()=>encodeIdentityWrite({operation:"create_identity",kind,subjectId,stewardIds,environments})).toThrow("no internal subject");
  });
  it("refuses missing subject, empty sponsors and duplicate sponsors",()=>{
    for(const overrides of [{subjectId:null},{stewardIds:[]},{stewardIds:[U(3),U(3)]}]) expect(()=>encodeIdentityWrite({operation:"create_identity",kind:"agent",subjectId,stewardIds,environments,...overrides})).toThrow();
  });
  it("edit maps stewards to sponsorUserIds",()=>expect(encodeIdentityWrite({operation:"edit_identity",identityId,stewardIds,environments}).body).toEqual({sponsorUserIds:stewardIds,environments}));
  it("terminal revoke has its own POST rather than a revoked PATCH",()=>{
    expect(encodeIdentityWrite({operation:"identity_status",identityId,status:"revoked"})).toEqual({method:"POST",path:`/v1/workload-identities/${identityId}/revoke`,body:{}});
    expect(encodeIdentityWrite({operation:"identity_status",identityId,status:"suspended"})).toEqual({method:"PATCH",path:`/v1/workload-identities/${identityId}`,body:{status:"suspended"}});
  });
  it("rotation adds only the public credential without implicitly revoking previous key",()=>{
    expect(encodeIdentityWrite({operation:"rotate_credential",identityId,previousCredentialId:U(4),publicKey,notAfter})).toEqual({method:"POST",path:`/v1/workload-identities/${identityId}/credentials`,body:{kind:"jwk",publicJwk:publicKey,notAfter}});
  });
  it("rejects private members before public whitelist, never leaking the private marker",()=>{
    const command={operation:"add_credential",identityId,publicKey:{...publicKey,d:"PRIVATE_SYNTHETIC_MARKER"},notAfter} as IdentityWrite;
    try { encodeIdentityWrite(command); throw new Error("Unexpected acceptance"); } catch(error) { expect(String(error)).toContain("Private or shared"); expect(String(error)).not.toContain("PRIVATE_SYNTHETIC_MARKER"); }
  });
  it("drops arbitrary key metadata rather than serializing it",()=>{
    const command={operation:"add_credential",identityId,publicKey:{...publicKey,kid:"UNTRUSTED_SYNTHETIC_MARKER"},notAfter} as IdentityWrite;
    expect(JSON.stringify(encodeIdentityWrite(command))).not.toContain("UNTRUSTED_SYNTHETIC_MARKER");
  });
  it("DELETE revocation preserves body omission and step-up headers",async()=>{
    const spy=vi.spyOn(api,"delWithHeaders").mockResolvedValue({});
    const headers={"x-regulait-step-up":"synthetic-grant"};
    const request=encodeIdentityWrite({operation:"revoke_credential",identityId,credentialId:U(4)});
    expect(request).not.toHaveProperty("body");
    await sendIdentityWrite(request,headers);
    expect(spy).toHaveBeenCalledWith(`/v1/workload-identities/${identityId}/credentials/${U(4)}`,headers,undefined);
  });
  it("requires a complete current set for both additions and removals",()=>{
    expect(()=>encodeIdentityWrite(add("role"))).toThrow("complete grants");
    expect(()=>encodeIdentityWrite({operation:"remove_grant",identityId,grantId:U(9)})).toThrow("complete grants");
  });
  it("preserves unrelated grants and roles in replacement PUT",()=>{
    const original=[grant(),grant({id:U(10),kind:"role",targetId:U(11),toolName:null,access:null})];
    expect(encodeIdentityWrite(add("role"),original)).toEqual({method:"PUT",path:`/v1/workload-identities/${identityId}/grants`,body:{revision:0,tools:[{serverId:U(8),toolName:"read_record"}],servers:[],agents:[],connectors:[],roleIds:[U(11),U(7)]}});
  });
  it("removal replaces only the identified grant and refuses stale/duplicate snapshots",()=>{
    expect(encodeIdentityWrite({operation:"remove_grant",identityId,grantId:U(9)},[grant()]).body).toEqual({revision:0,tools:[],servers:[],agents:[],connectors:[],roleIds:[]});
    expect(()=>encodeIdentityWrite({operation:"remove_grant",identityId,grantId:U(10)},[grant()])).toThrow("changed");
    expect(()=>encodeIdentityWrite(add("role"),[grant(),grant()])).toThrow("Refresh");
  });
  it("never infers readOnlyAll, modes or objects from generic access",()=>{
    for(const kind of ["server","agent_invoke","connector"] as const) expect(()=>encodeIdentityWrite(add(kind,{access:"read"}),[])).toThrow();
  });
  it("empty required lists remain empty, with no implicit wildcards",()=>{
    expect(encodeIdentityWrite(add("agent_invoke",{allowedModes:[]}),[]).body).toEqual({revision:0,tools:[],servers:[],agents:[{agentId:U(7),allowedModes:[]}],connectors:[],roleIds:[]});
    expect(encodeIdentityWrite(add("connector",{mode:"read",allowedObjects:[]}),[]).body).toEqual({revision:0,tools:[],servers:[],agents:[],connectors:[{connectorId:U(7),mode:"read",allowedObjects:[]}],roleIds:[]});
    expect(encodeIdentityWrite(add("server",{readOnlyAll:false}),[]).body).toEqual({revision:0,tools:[],servers:[{serverId:U(7),readOnlyAll:false}],agents:[],connectors:[],roleIds:[]});
  });
  it("duplicate targets refuse rather than replacing existing privileges silently",()=>{
    expect(()=>encodeIdentityWrite(add("tool",{targetId:U(8),toolName:"read_record"}),[grant()])).toThrow();
  });
  it("refuses malformed existing grants even when trying to remove that row",()=>{
    const row=grant({kind:"connector",toolName:null});
    expect(()=>encodeIdentityWrite({operation:"remove_grant",identityId,grantId:row.id},[row])).toThrow();
  });
  it("captured payload remains byte-identical across step-up retry and later state mutation",async()=>{
    const command: Extract<IdentityWrite, { operation: "edit_identity" }> = {operation:"edit_identity",identityId,stewardIds:[...stewardIds],environments:[...environments]};
    const request=encodeIdentityWrite(command);
    const serialized=JSON.stringify(request);
    command.stewardIds.push(U(5));
    const spy=vi.spyOn(api,"patchWithHeaders").mockResolvedValue({});
    await sendIdentityWrite(request,{}); await sendIdentityWrite(request,{"x-regulait-step-up":"synthetic"});
    expect(JSON.stringify(request)).toBe(serialized);
    expect(Object.isFrozen(request.body)).toBe(true);
    expect(spy.mock.calls[0]?.[1]).toBe(spy.mock.calls[1]?.[1]);
  });
  it("delegation cascade revocation uses only the grant route and empty body",()=>expect(encodeIdentityWrite({operation:"revoke_delegation",grantId:U(6)})).toEqual({method:"POST",path:`/v1/delegation-grants/${U(6)}/revoke`,body:{}}));
  it("read descriptors invent neither envelopes nor a run filter",()=>{
    expect(identityReadRequests(identityId).delegationGrants).toEqual({method:"GET",path:"/v1/delegation-grants"});
    expect(identityReadRequests(identityId).grants?.path).toBe(`/v1/workload-identities/${identityId}/grants`);
    expect(()=>identityReadRequests("../oauth/token")).toThrow();
  });
});

it("grant revision is required and frozen with the complete replacement before step-up", () => {
  expect(() => encodeIdentityWriteRequest(add("role"), [], undefined)).toThrow("revision");
  expect(() => encodeIdentityWriteRequest(add("role"), [], -1)).toThrow("revision");
  const request = encodeIdentityWriteRequest(add("role"), [], 7);
  expect(request.body).toMatchObject({ revision: 7 });
  expect(Object.isFrozen(request.body)).toBe(true);
});
