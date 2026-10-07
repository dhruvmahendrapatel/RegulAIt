/** ADR-0186 M. Observational rules over retained decision/activation ledgers.
 * Event episodes use a 24-hour observation window; the MCP baseline is the
 * immediately preceding configured days. Missing approval/prompt history is
 * HELD, never interpreted as unchanged. No prompts/reasons/arguments leave
 * this loader. A bounded query overflow throws, leaving all four unevaluated.
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
 return db.transaction(async tx=>{
  const drift=await rows<{agentId:string;serverId:string;calls:number}>(tx,sql`
    SELECT coalesce(a.detail->>'builderAgentId',a.detail->>'agentId') AS "agentId",a.server_id AS "serverId",count(*)::int AS calls
    FROM audit_log a WHERE a.object_type='mcp_tool' AND a.server_id IS NOT NULL AND a.tool_name IS NOT NULL
      AND a.at>=${recent}::timestamptz AND a.at<=${end}::timestamptz
      AND coalesce(a.detail->>'builderAgentId',a.detail->>'agentId') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM audit_log b WHERE b.object_type='mcp_tool' AND b.tool_name IS NOT NULL
        AND b.server_id=a.server_id AND coalesce(b.detail->>'builderAgentId',b.detail->>'agentId')=coalesce(a.detail->>'builderAgentId',a.detail->>'agentId')
        AND b.at>=${baseline}::timestamptz AND b.at<${recent}::timestamptz)
    GROUP BY 1,2 LIMIT ${MAX_SUBJECTS+1}`);
  const driftInput=measured(drift.filter(row=>uuid(row.agentId)&&uuid(row.serverId)).map(row=>({
    subjectKey:`builder_agent:${row.agentId}>mcp_server:${row.serverId}`,
    title:`Agent ${row.agentId} called a server outside its observed MCP baseline`,
    detail:{agentId:row.agentId,serverId:row.serverId,observedCalls:row.calls,baselineDays:settings.monitorMcpBaselineDays,observationHours:24},
  })));
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
  const prompts=await rows<{caseId:string;agentId:string;activeId:string|null;approvedId:string|null;approvalAt:Date|null;priorAction:string|null;historyStates:string|null}>(tx,sql`
    SELECT u.id AS "caseId", agent.id AS "agentId", current.id AS "activeId", history.version_id AS "approvedId",
      approval.at AS "approvalAt", history.action AS "priorAction", history.states::text AS "historyStates"
    FROM ai_use_cases u CROSS JOIN LATERAL jsonb_array_elements_text(u.intended_agent_ids) agent(id)
    LEFT JOIN LATERAL(SELECT d.created_at AS at FROM decisions d WHERE d.object_type='workflow_instance'
      AND d.object_id=u.workflow_instance_id AND d.decision='approved' AND d.created_at<=${end}::timestamptz
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1) approval ON true
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
  const events=await rows<{userId:string;at:Date;seq:string|null;type:string;effect:string;findings:unknown}>(tx,sql`
    SELECT user_id AS "userId",at,seq::text AS seq,object_type AS type,effect,
      detail->'guardrail'->'findings' AS findings FROM audit_log
    WHERE at>=${jailbreakStart}::timestamptz AND at<=${end}::timestamptz
      AND (rule_id IN ('guardrail-blocked','guardrail-warned','guardrail-logged') OR (object_type='mcp_tool' AND tool_name IS NOT NULL AND effect='allow'))
    ORDER BY at,seq LIMIT ${MAX_SUBJECTS+1}`);
  const userCounts=new Map<string,number>(),correlated=new Map<string,number>();
  // Rows with equal timestamps need the append-only sequence to prove order.
  // A same-timestamp call is correlated only when both ledger sequences
  // prove the ordering; ambiguous legacy timestamp ties contribute nothing.
  const thresholds=new Map<string,{at:number;seq:bigint|null}>();
  for(const event of events){
    if(!uuid(event.userId)||event.userId===NIL)continue;
    const time=new Date(event.at).getTime();if(!Number.isFinite(time))throw new Error("detection_monitor_timestamp_invalid");
    const seq=event.seq!==null?BigInt(event.seq):null;
    if(event.findings!==null){
      if(!Array.isArray(event.findings))throw new Error("detection_monitor_findings_invalid");
      let count=0;for(const finding of event.findings){if(finding&&typeof finding==='object'&&finding.detector==='jailbreak'){
        if(!Number.isSafeInteger(finding.count)||finding.count<0)throw new Error("detection_monitor_count_invalid");count=Math.min(1000000,count+finding.count);
      }}
      const total=Math.min(1000000,(userCounts.get(event.userId)??0)+count);userCounts.set(event.userId,total);
      if(total>=settings.monitorJailbreakThreshold&&!thresholds.has(event.userId))thresholds.set(event.userId,{at:time,seq});
    }
    if(event.type==='mcp_tool'&&event.effect==='allow'){
      const reached=thresholds.get(event.userId);
      if(reached&&(time>reached.at||(time===reached.at&&seq!==null&&reached.seq!==null&&seq>reached.seq)))correlated.set(event.userId,(correlated.get(event.userId)??0)+1);
    }
  }
  return {
    mcp_server_baseline_drift:driftInput,
    sharing_scope_widened:measured([...sharingBreaches.values()],[...sharingHeld].filter(key=>!sharingBreaches.has(key))),
    instructions_changed_after_approval:promptInput,
    jailbreak_correlation:measured([...correlated].map(([userId,calls])=>({subjectKey:`user:${userId}`,title:`Jailbreak findings for user ${userId} were followed by an allowed tool call`,detail:{userId,findings:userCounts.get(userId),allowedCallsAfterThreshold:calls,threshold:settings.monitorJailbreakThreshold,windowHours:settings.monitorJailbreakWindowHours}}))),
  };
 },{isolationLevel:"repeatable read",accessMode:"read only"});
}
