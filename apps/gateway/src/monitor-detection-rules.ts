/** ADR-0186 M. Observational rules over retained decision/activation ledgers.
 * Event episodes use a 24-hour observation window; the MCP baseline is the
 * immediately preceding configured days. Missing approval/prompt history is
 * HELD, never interpreted as unchanged. No prompts/reasons/arguments leave
 * this loader. A failed or overflowing rule is omitted; the other rules remain measured.
 */
import { sql, type Db, type SQL } from "@regulait/db";
import type { DetectionMonitorRuleId, MonitorAssuranceInput, MonitorAssuranceSubject } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
const MAX_SUBJECTS=10000, DAY=86400000, NIL="00000000-0000-0000-0000-000000000000";
const uuid=(value:unknown):value is string=>typeof value==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
type QueryDb=Pick<Db,"execute">;
async function rows<T>(db:QueryDb,query:SQL):Promise<T[]> {
 const result=await db.execute(query);const values=(result as unknown as {rows:T[]}).rows;
 if(!Array.isArray(values)||values.length>MAX_SUBJECTS)throw new Error("detection_monitor_input_limit");return values;
}
const measured=(breaches:MonitorAssuranceSubject[]=[],heldSubjectKeys:string[]=[]):MonitorAssuranceInput=>({breaches,heldSubjectKeys});
export async function detectionMonitorInput(db:Db,now:Date):Promise<Partial<Record<DetectionMonitorRuleId,MonitorAssuranceInput>>> {
 if(!Number.isFinite(now.getTime()))throw new Error("detection_monitor_clock_invalid");
 const settings=await loadOrgSettings(db), end=now.toISOString(), recent=new Date(now.getTime()-DAY).toISOString();
 const baseline=new Date(now.getTime()-DAY*(1+settings.monitorMcpBaselineDays)).toISOString();
 const jailbreakStart=new Date(now.getTime()-settings.monitorJailbreakWindowHours*3600000).toISOString();
 return db.transaction(async snapshot=>{
  const output:Partial<Record<DetectionMonitorRuleId,MonitorAssuranceInput>>={};
  // Savepoints recover SQL failures without aborting the shared read snapshot.
  const rule=async(key:DetectionMonitorRuleId,load:(tx:Db)=>Promise<MonitorAssuranceInput>)=>{
    try{output[key]=await snapshot.transaction(load);}catch{/* Omit this rule only: existing episodes are held. */}
  };
  await rule("mcp_server_baseline_drift",async tx=>{
  const drift=await rows<{agentId:string;serverId:string;calls:number}>(tx,sql`
    SELECT coalesce(a.detail->>'builderAgentId',a.detail->>'agentId') AS "agentId",a.server_id AS "serverId",count(*)::int AS calls
    FROM audit_log a WHERE a.object_type='mcp_tool' AND a.server_id IS NOT NULL AND a.tool_name IS NOT NULL
      AND a.at>=${recent}::timestamptz AND a.at<=${end}::timestamptz
      AND coalesce(a.detail->>'builderAgentId',a.detail->>'agentId') IS NOT NULL
      AND EXISTS(SELECT 1 FROM audit_log known WHERE known.object_type='mcp_tool' AND known.tool_name IS NOT NULL
        AND coalesce(known.detail->>'builderAgentId',known.detail->>'agentId')=coalesce(a.detail->>'builderAgentId',a.detail->>'agentId')
        AND known.at<${recent}::timestamptz)
      AND NOT EXISTS(SELECT 1 FROM audit_log b WHERE b.object_type='mcp_tool' AND b.tool_name IS NOT NULL
        AND b.server_id=a.server_id AND coalesce(b.detail->>'builderAgentId',b.detail->>'agentId')=coalesce(a.detail->>'builderAgentId',a.detail->>'agentId')
        AND b.at>=${baseline}::timestamptz AND b.at<${recent}::timestamptz)
    GROUP BY 1,2 LIMIT ${MAX_SUBJECTS+1}`);
  const driftInput=measured(drift.filter(row=>uuid(row.agentId)&&uuid(row.serverId)).map(row=>({
    subjectKey:`builder_agent:${row.agentId}>mcp_server:${row.serverId}`,
    title:`Agent ${row.agentId} called a server outside its observed MCP baseline`,
    detail:{agentId:row.agentId,serverId:row.serverId,observedCalls:row.calls,baselineDays:settings.monitorMcpBaselineDays,observationHours:24},
  })));
  return driftInput;
  });
  await rule("sharing_scope_widened",async tx=>{
  const sharing=await rows<{id:string;type:string;from:string;to:string;priorKnown:boolean;added:number|null}>(tx,sql`
    SELECT a.object_id AS id,a.object_type AS type,a.detail->>'from' AS "from",
      coalesce(a.detail->>'to',a.detail->>'requested') AS "to", prior.members IS NOT NULL AS "priorKnown",
      CASE WHEN jsonb_typeof(a.detail->'sharedUserIds')='array' AND prior.members IS NOT NULL THEN
        (SELECT count(*)::int FROM (SELECT jsonb_array_elements_text(a.detail->'sharedUserIds') EXCEPT SELECT jsonb_array_elements_text(prior.members)) added) ELSE NULL END AS added
    FROM audit_log a LEFT JOIN LATERAL(SELECT b.detail->'sharedUserIds' AS members FROM audit_log b
      WHERE b.object_type=a.object_type AND b.object_id=a.object_id AND b.rule_id='builder-agent-sharing-changed'
        AND jsonb_typeof(b.detail->'sharedUserIds')='array' AND (b.at<a.at OR (b.at=a.at AND b.seq<a.seq))
      ORDER BY b.at DESC,b.seq DESC LIMIT 1) prior ON true
    WHERE a.at>=${recent}::timestamptz AND a.at<=${end}::timestamptz AND a.effect='allow'
      AND ((a.object_type='builder_agent' AND a.rule_id='builder-agent-sharing-changed')
        OR (a.object_type='builder_skill' AND a.rule_id='builder-skill-visibility-approved'))
    ORDER BY a.at,a.seq LIMIT ${MAX_SUBJECTS+1}`);
  const sharingBreaches=new Map<string,MonitorAssuranceSubject>(), sharingHeld=new Set<string>();
  const ranks:Record<string,number>={private:0,people:1,workspace:2};
  for(const row of sharing){
    if(!uuid(row.id))continue;const key=`${row.type}:${row.id}`;
    if(!Object.hasOwn(ranks,row.from)||!Object.hasOwn(ranks,row.to)){sharingHeld.add(key);continue;}
    if(ranks[row.to]!>ranks[row.from]! || (row.from==='people'&&row.to==='people'&&Number(row.added)>0)){
      sharingBreaches.set(key,{subjectKey:key,title:`Sharing scope widened for ${row.type} ${row.id}`,detail:{from:row.from,to:row.to,...(row.added!==null?{addedRecipients:row.added}:{}),observationHours:24}});
    }else if(row.from==='people'&&row.to==='people'&&row.added===null)sharingHeld.add(key);
  }
  return measured([...sharingBreaches.values()],[...sharingHeld].filter(key=>!sharingBreaches.has(key)));
  });
  await rule("instructions_changed_after_approval",async tx=>{
  const prompts=await rows<{caseId:string;agentId:string;activeId:string|null;approvedId:string|null;approvalAt:Date|null;priorAction:string|null;historyStates:string|null}>(tx,sql`
    SELECT u.id AS "caseId", agent.id AS "agentId", current.id AS "activeId", history.version_id AS "approvedId",
      approval.at AS "approvalAt", history.action AS "priorAction", history.states::text AS "historyStates"
    FROM ai_use_cases u CROSS JOIN LATERAL jsonb_array_elements_text(u.intended_agent_ids) agent(id)
    LEFT JOIN LATERAL(SELECT d.decided_at AS at FROM use_case_decision_records d WHERE d.use_case_id=u.id
      AND d.outcome='approved' AND d.decided_at<=${end}::timestamptz
      ORDER BY d.decided_at DESC,d.id DESC LIMIT 1) approval ON true
    LEFT JOIN config_versions current ON current.artifact_type='agent_system_prompt' AND current.artifact_id::text=agent.id AND current.status='active'
    LEFT JOIN LATERAL(SELECT e.version_id,e.action,count(*) OVER (PARTITION BY e.at) AS states FROM config_activation_events e WHERE e.artifact_type='agent_system_prompt'
      AND e.artifact_id::text=agent.id AND e.at<=approval.at AND e.action IN ('activated','promoted','rolled_back','artifact_deleted')
      ORDER BY e.at DESC,e.id DESC LIMIT 1) history ON true
    WHERE u.status='approved' LIMIT ${MAX_SUBJECTS+1}`);
  const promptInput=measured();
  for(const row of prompts){
    if(!uuid(row.agentId))continue;const key=`use_case:${row.caseId}>agent:${row.agentId}`;
    if(!row.approvalAt||!row.activeId||!row.approvedId||row.priorAction==='artifact_deleted'||Number(row.historyStates)>1){promptInput.heldSubjectKeys!.push(key);continue;}
    if(row.activeId!==row.approvedId)promptInput.breaches.push({subjectKey:key,title:`Agent ${row.agentId} instructions changed after use case ${row.caseId} approval`,detail:{useCaseId:row.caseId,agentId:row.agentId,approvedVersionId:row.approvedId,activeVersionId:row.activeId}});
  }
  return promptInput;
  });
  await rule("jailbreak_correlation",async tx=>{
    // Validate only guardrail finding rows; tool-call volume never crosses the
    // process boundary. Numeric casts run only after JSON type validation.
    const malformed=await tx.execute(sql`
      SELECT 1 FROM audit_log a WHERE a.at>=${jailbreakStart}::timestamptz AND a.at<=${end}::timestamptz
      AND a.rule_id IN ('guardrail-blocked','guardrail-warned','guardrail-logged')
      AND (CASE WHEN a.detail->'guardrail'->'findings' IS NULL THEN false
        WHEN jsonb_typeof(a.detail->'guardrail'->'findings')<>'array' THEN true
        ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(a.detail->'guardrail'->'findings') f
          WHERE f->>'detector'='jailbreak' AND CASE WHEN jsonb_typeof(f->'count')='number'
            THEN (f->>'count')::numeric<0 OR (f->>'count')::numeric>9007199254740991
              OR trunc((f->>'count')::numeric)<>(f->>'count')::numeric ELSE true END) END) LIMIT 1`);
    if((malformed as unknown as {rows:unknown[]}).rows.length)throw new Error("detection_monitor_findings_invalid");
    const correlated=await rows<{userId:string;findings:string;calls:string}>(tx,sql`
      WITH findings AS (
        SELECT a.user_id,a.at,a.seq,coalesce(sum((f->>'count')::numeric) FILTER(WHERE f->>'detector'='jailbreak'),0) AS n
        FROM audit_log a LEFT JOIN LATERAL jsonb_array_elements(coalesce(a.detail->'guardrail'->'findings','[]'::jsonb)) f ON true
        WHERE a.at>=${jailbreakStart}::timestamptz AND a.at<=${end}::timestamptz
          AND a.rule_id IN ('guardrail-blocked','guardrail-warned','guardrail-logged')
          AND a.user_id IS NOT NULL AND a.user_id<>${NIL}::uuid
        GROUP BY a.id,a.user_id,a.at,a.seq
      ), running AS (
        SELECT *,sum(n) OVER(PARTITION BY user_id ORDER BY at,seq NULLS LAST ROWS UNBOUNDED PRECEDING) AS total
        FROM findings
      ), thresholds AS (
        SELECT DISTINCT ON(user_id) user_id,at,seq FROM running WHERE total>=${settings.monitorJailbreakThreshold}
        ORDER BY user_id,at,seq NULLS LAST
      ), totals AS (SELECT user_id,sum(n) AS total FROM findings GROUP BY user_id)
      SELECT t.user_id AS "userId",least(total,1000000)::text AS findings,count(*)::text AS calls
      FROM thresholds t JOIN totals f ON f.user_id=t.user_id JOIN audit_log a ON a.user_id=t.user_id
        AND a.object_type='mcp_tool' AND a.tool_name IS NOT NULL AND a.effect='allow'
        AND a.at<=${end}::timestamptz
        AND (a.at>t.at OR (a.at=t.at AND a.seq IS NOT NULL AND t.seq IS NOT NULL AND a.seq>t.seq))
      GROUP BY t.user_id,total LIMIT ${MAX_SUBJECTS+1}`);
    return measured(correlated.map(({userId,findings,calls})=>({subjectKey:`user:${userId}`,title:`Jailbreak findings for user ${userId} were followed by an allowed tool call`,detail:{userId,findings:Number(findings),allowedCallsAfterThreshold:Number(calls),threshold:settings.monitorJailbreakThreshold,windowHours:settings.monitorJailbreakWindowHours}})));
  });
  return output;
 },{isolationLevel:"repeatable read",accessMode:"read only"});
}
