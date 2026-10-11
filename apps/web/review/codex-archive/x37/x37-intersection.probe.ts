/** Independent X37 review, source SHA 94fffb65. Copy into policy-kernel/src as
 * x37-independent.test.ts for its declared Vitest runner; never production code. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, evaluateAgent, evaluateConnector, scopeCovers, scopeSubset,
  type GovernedActor, type ActorEntitlements, type DelegationScope,
  type EvaluationInput, type EvaluateAgentInput, type EvaluateConnectorInput } from './index.js';
import { abacEngine, type AbacRequest, type AbacPolicy } from './abac.js';
const full: ActorEntitlements = {tools:[{serverId:'s',toolName:'t'}],servers:[],agents:[{agentId:'a',allowedModes:['plan','execute']}],connectors:[{connectorId:'c',mode:'readwrite',allowedObjects:['o']}]};
const none: ActorEntitlements = {tools:[],servers:[],agents:[],connectors:[]};
const scope: DelegationScope = [
  {type:'mcp_tool',serverId:'s',toolNames:['t'],kind:'read'},
  {type:'mcp_tool',serverId:'s',toolNames:['t'],kind:'write'},
  {type:'agent',agentId:'a',modes:['plan'],kind:'read'},
  {type:'agent',agentId:'a',modes:['execute'],kind:'write'},
  {type:'connector',connectorId:'c',kind:'read'},
  {type:'connector',connectorId:'c',kind:'write'},
];
type MutableActor = {-readonly [K in keyof GovernedActor]: GovernedActor[K]};
function chain(n: number): MutableActor { return {
  chain:{sponsorUserId:'u',delegationGrantId:`g${n-1}`,depth:n,actors:Array.from({length:n},(_,i)=>({identityId:`i${i}`,kind:'agent',identifier:`spiffe://example.org/a/${i}`}))},
  entitlementMode:'own_grants',maxDepth:8,costKnown:true,
  links:Array.from({length:n},(_,i)=>({identityId:`i${i}`,grantId:`g${i}`,live:true,scope,budget:null,entitlements:full})),
}; }
const tool=(actor:GovernedActor|null, sponsor=true, write=false):EvaluationInput=>({userId:'u',serverId:'s',execution:{mode:'normal'},actor,tool:{serverId:'s',name:'t',kind:write?'write':'read'},toolGrants:sponsor?[{id:'sponsor',userId:'u',serverId:'s',toolName:'t'}]:[],serverGrants:[]});
const agent=(actor:GovernedActor|null,sponsor=true,write=false):EvaluateAgentInput=>({userId:'u',execution:{mode:'normal'},actor,agent:{id:'a',name:'A',tier:1,enabled:true,modes:['plan','execute']},mode:write?'execute':'plan',agentGrants:sponsor?[{id:'sponsor',userId:'u',agentId:'a',allowedModes:null}]:[]});
const connector=(actor:GovernedActor|null,sponsor=true,write=false):EvaluateConnectorInput=>({userId:'u',execution:{mode:'normal'},actor,connectorId:'c',operation:write?'write':'read',object:'o',connectorGrants:sponsor?[{id:'sponsor',userId:'u',connectorId:'c',mode:'readwrite',allowedObjects:null}]:[]});
const paths=[(a:GovernedActor|null,s=true,w=false)=>evaluate(tool(a,s,w)),(a:GovernedActor|null,s=true,w=false)=>evaluateAgent(agent(a,s,w)),(a:GovernedActor|null,s=true,w=false)=>evaluateConnector(connector(a,s,w))];
type RequiredActor<T extends {actor: GovernedActor|null}> = Omit<T,'actor'> extends T ? false : true;
const compileRequired: [RequiredActor<EvaluationInput>,RequiredActor<EvaluateAgentInput>,RequiredActor<EvaluateConnectorInput>] = [true,true,true];

describe('X37 independent finite and generated intersections',()=>{
  it('actor is required on all three compile-time inputs',()=>expect(compileRequired).toEqual([true,true,true]));
  for(const [p,decide] of paths.entries()) {
    it(`path ${p}: exhaustive 1,024 sponsor × own grants × scope × liveness × budgets × Cedar × mode combinations`,()=>{
      let allowed=0,denied=0;
      for(let bits=0;bits<256;bits++) for(const relaxed of [false,true]) for(const write of [false,true]) {
        const a=chain(3), sponsor=Boolean(bits&1);
        a.entitlementMode=relaxed?'sponsor_only':'own_grants';
        a.links=a.links.map((l,i)=>({...l,entitlements:bits&(2<<i)?full:none,
          scope:bits&16?scope:[],live:Boolean(bits&32),
          budget:bits&64?{remainingMicros:5}:{remainingMicros:-1},
          abacDecision:bits&128?{effect:'permit'}:{effect:'forbid',policyId:'independent-forbid'}}));
        const shouldAllow=sponsor&&(relaxed||Boolean((bits&14)===14))&&Boolean(bits&16)&&Boolean(bits&32)&&Boolean(bits&64)&&Boolean(bits&128);
        const d=decide(a,sponsor,write);
        expect(d.effect==='allow',JSON.stringify({p,bits,relaxed,write,decision:d})).toBe(shouldAllow);
        shouldAllow?allowed++:denied++;
      }
      expect(allowed).toBe(18); expect(denied).toBe(1006);
    });
    it(`path ${p}: 1,200 generated clean witnesses then one root/middle/leaf restriction always refuses, even sponsor_only`,()=>{
      fc.assert(fc.property(fc.integer({min:1,max:9}),fc.nat(),fc.constantFrom('grant','live','scope','budget','cedar','depth','sponsor'),fc.boolean(),(n,which,term,relaxed)=>{
        const a=chain(n); a.entitlementMode=relaxed?'sponsor_only':'own_grants';
        expect(decide(a).effect).toBe('allow');
        const i=which%n;
        switch(term){
          case 'grant': a.links=a.links.map((l,j)=>j===i?{...l,entitlements:none}:l);break;
          case 'live': a.links=a.links.map((l,j)=>j===i?{...l,live:false}:l);break;
          case 'scope': a.links=a.links.map(l=>({...l,scope:[]}));break;
          case 'budget':a.links=a.links.map((l,j)=>j===i?{...l,budget:{remainingMicros:-1}}:l);break;
          case 'cedar':a.links=a.links.map((l,j)=>j===i?{...l,abacDecision:{effect:'forbid',policyId:'p'}}:l);break;
          case 'depth':if(n===1) a.maxDepth=-1;else a.maxDepth=n-2;break;
          case 'sponsor':a.chain={...a.chain,sponsorUserId:'other'};break;
        }
        expect(decide(a).effect).toBe(term==='grant'&&relaxed?'allow':'deny');
      }),{seed:3700+p,numRuns:1200});
    });
    it(`path ${p}: reversed facts, repeated grants and root-first scope widening are refused and traced`,()=>{
      for(const mutate of [(a:GovernedActor)=>({...a,links:[...a.links].reverse()}),(a:GovernedActor)=>({...a,links:a.links.map(l=>({...l,grantId:'g2'}))}),(a:GovernedActor)=>({...a,links:a.links.map((l,i)=>({...l,scope:i===0?[]:scope}))})]){
        const d=decide(mutate(chain(3)));expect([d.effect,d.ruleId]).toEqual(['deny','actor-chain-invalid']);expect(d.ruleChain.at(-1)?.outcome).toBe('deny');
      }
    });
  }
  it('lead ceilings cannot be rescued by full own grants or sponsor_only',()=>{
    for(const relaxed of [false,true]){const a=chain(3);a.entitlementMode=relaxed?'sponsor_only':'own_grants';
      expect(evaluate({...tool(a),ceilingTools:[]}).effect).toBe('deny');
      expect(evaluateAgent({...agent(a),ceilingAgentIds:[]}).effect).toBe('deny');
      expect(evaluateAgent({...agent(a),ceilingTier:0}).effect).toBe('deny');
    }
  });
  it('approval and execution posture never rescue an actor denial; budget zero and unknown costs are exact',()=>{
    const a=chain(3);a.links=a.links.map((l,i)=>i===1?{...l,entitlements:none}:l);
    expect(evaluate({...tool(a),execution:{mode:'require_approval',approverUserId:'boss'}}).ruleId).toBe('actor-allow-list');
    expect(evaluate({...tool(a),approvedApprovalId:'already-approved'}).ruleId).toBe('actor-allow-list');
    for(const decide of paths){
      const b=chain(2);b.links=b.links.map((l,i)=>({...l,budget:{remainingMicros:i===0?0:1}}));
      expect(decide(b).effect).toBe('allow');
      b.costKnown=false;expect(decide(b).ruleId).toBe('delegation-budget');
      b.costKnown=true;b.links=b.links.map(l=>({...l,budget:{remainingMicros:0}}));expect(decide(b).ruleId).toBe('delegation-budget');
      for(const remainingMicros of [NaN,Infinity,-Infinity]){
        b.links=b.links.map(l=>({...l,budget:{remainingMicros}}));expect(decide(b).ruleId).toBe('delegation-budget');
      }
    }
  });
  it('scope kinds and modes are exact for 1,000 generated atoms',()=>{
    fc.assert(fc.property(fc.string({minLength:1,maxLength:20}),fc.constantFrom('read','write'),(mode,kind)=>{
      const one:DelegationScope=[{type:'agent',agentId:'a',modes:[mode],kind}];
      expect(scopeCovers(one,{type:'agent',agentId:'a',mode,kind})).toBe(true);
      expect(scopeCovers(one,{type:'agent',agentId:'a',mode,kind:kind==='read'?'write':'read'})).toBe(false);
      expect(scopeCovers(one,{type:'agent',agentId:'a',mode:mode+'x',kind})).toBe(false);
      expect(scopeSubset([{type:'agent',agentId:'a',modes:[mode+'x'],kind}],one)).toBe(false);
      expect(scopeCovers([{type:'agent',agentId:'a',kind}],{type:'agent',agentId:'a',mode,kind})).toBe(false);
    }),{seed:3744,numRuns:1000});
  });
  it('property negative controls catch sponsor-union, leaf-only and dropped Cedar mutants',()=>{
    for(const mutant of ['union','leaf','cedar']){
      const result=fc.check(fc.property(fc.integer({min:0,max:2}),i=>{
        const a=chain(3);a.links=a.links.map((l,j)=>j===i?{...l,...(mutant==='cedar'?{abacDecision:{effect:'forbid' as const,policyId:'p'}}:{entitlements:none})}:l);
        const wrong=mutant==='union'||mutant==='cedar'||a.links.at(-1)!.entitlements===full;
        return wrong === (evaluate(tool(a)).effect==='allow');
      }),{seed:3799,numRuns:100});
      expect(result.failed,mutant).toBe(true);expect(result.counterexample).not.toBeNull();
    }
  });
});
const req:AbacRequest={principal:{id:'u',roles:[],roleIds:[],teams:[],isAdmin:true,sessionOrigin:'password',mfaCompleted:true},resource:{id:'s/t',serverId:'s',serverName:'S',toolName:'t',kind:'read',priceTier:'metered',classifications:[]},context:{deployModes:[],environments:[],rateLimitUsagePct:0},delegation:{actorChain:['i0','i1','i2'],delegationDepth:3}};
const pol=(id:string,source:string,schemaVersion='v4'):AbacPolicy=>({id,name:id,source,schemaVersion,timezone:'UTC',mode:'forbid'});
describe('X37 actual Cedar WASM principal isolation',()=>{
  it('each principal is evaluated separately; a middle actor forbid reaches the kernel',()=>{
    const policy=pol('middle',`forbid(principal == RegulAIt::Agent::"i1", action, resource);`);
    expect(abacEngine.validate(policy.source,'v4').ok).toBe(true);
    expect(abacEngine.evaluate([policy],req).effect).toBe('permit');
    const a=chain(3);a.links=a.links.map(l=>({...l,abacDecision:abacEngine.evaluate([policy],{...req,agent:{id:l.identityId,kind:'agent',identifier:`spiffe://example.org/${l.identityId}`,environments:[],stewards:['u']}})}));
    expect(a.links.map(l=>l.abacDecision?.effect)).toEqual(['permit','forbid','permit']);
    for(const decide of paths)expect([decide(a).effect,decide(a).ruleId]).toEqual(['deny','middle']);
  });
  it('legacy human forbids do not run on Agent; Cedar permit cannot confer missing grants',()=>{
    const legacy=pol('legacy','forbid(principal, action, resource);','v3');
    const asAgent={...req,agent:{id:'i0',kind:'agent',identifier:'spiffe://example.org/i0',environments:[],stewards:['u']}};
    expect(abacEngine.evaluate([legacy],req).effect).toBe('forbid');expect(abacEngine.evaluate([legacy],asAgent).effect).toBe('permit');
    const permit=pol('permit','permit(principal, action, resource);');
    expect(abacEngine.evaluate([permit],asAgent).effect).toBe('permit');
    const a=chain(1);a.links=a.links.map(l=>({...l,entitlements:none,abacDecision:{effect:'permit'}}));
    for(const decide of paths) expect(decide(a).ruleId).toBe('actor-allow-list');
  });
});
