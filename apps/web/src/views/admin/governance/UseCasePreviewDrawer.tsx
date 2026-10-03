/**
 * The registry's right-hand preview (ADR-0168 item 2): a row opens it without
 * leaving the list. It shows what a reviewer scans for — status, tier, owner,
 * validity, open conditions, the purpose — and its one primary action is
 * "Open use case". The work itself (questionnaire, risks, review) happens on
 * the record page and in the intake workflow, never here.
 *
 * Kept from the register's former inline detail, because nothing else offers
 * them yet: the intended-agent capture (pre-decision only), finishing the
 * resting plan stage, the compliance-tag consequences and retirement.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, frameworkLabel, humanize, plural, shortId } from "../../../api/format";
import { Badge, Button, Field, Input, Select } from "../../../ui/kit";
import { useAction, useAgents } from "../adminKit";
import { QuestionnaireView } from "./UseCaseQuestionnaire";
import {
  fmtDay,
  statusLabel,
  statusTone,
  tierLabel,
  tierTone,
  validity,
  type EuTier,
  type UseCaseRow,
  type UseCaseStatus,
} from "./registryModel";
import r from "./registry.module.css";
import k from "../../../ui/kit.module.css";
import v from "../../views.module.css";

interface EuScreening {
  tier: EuTier | null;
  reasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }> | null;
  rulesetVersion: number | null;
  disclaimer: string;
  answersStatus: "no_questionnaire" | "missing" | "invalid" | "ok";
  answersError: string | null;
  refusal: string | null;
}
interface RequiredTemplate { id: string; name: string; retired: boolean; stageIds: string[] }
interface CascadeCard {
  profiles: Array<{ tag: string; piiMode: string; auditRetentionDays: number | null; mcpDefaultMode: string; requiredTemplates: RequiredTemplate[] }>;
  unrecognizedTags: string[];
  combined: { piiMode: string; auditRetentionDays: number | null; mcpDefaultMode: string; requiredTemplates: RequiredTemplate[]; forcedStageIds: string[] } | null;
  project: { id: string; name: string; classifications: string[]; tagsCarried: string[]; tagsNotCarried: string[] } | null;
  note: string;
}
interface Condition {
  id: string;
  text: string;
  ownerName: string | null;
  dueAt: string;
  blocking: boolean;
  status: "open" | "met" | "waived";
  overdue: boolean;
}
export interface UseCaseDetail {
  useCase: UseCaseRow & { approvedAt?: string | null; approvalExpired?: boolean };
  instance: { id: string; status: string; currentStageId: string | null; stages: Array<{ id: string; type: string }> } | null;
  questionnaire: { version: number; content: string; createdAt: string } | null;
  cascadeConsequences: CascadeCard;
  euAiActScreening: EuScreening;
  intendedVsGranted: {
    status: "aligned" | "undershoot" | "not_approved" | "no_intent_recorded";
    note: string;
    agents?: Array<{ agentId: string; agentName: string | null; registered: boolean; grantedToParticipants: boolean; participantHolders: number }>;
  };
  conditions?: Condition[];
}

const PII_MODE_LABEL: Record<string, string> = { block: "Block", warn: "Warn", log: "Log only" };
const MCP_MODE_LABEL: Record<string, string> = { read_only: "Read only", read_write: "Read and write" };
const piiLabel = (m: string) => PII_MODE_LABEL[m] ?? humanize(m);
const mcpLabel = (m: string) => MCP_MODE_LABEL[m] ?? humanize(m);

/** where the intake workflow is, in the words of the person waiting on it */
const INSTANCE_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  blocked_on_plan: "Waiting for planning to finish",
  blocked_on_artifact: "Waiting for the questionnaire",
  blocked_on_approval: "Waiting for sign-off",
  completed: "Completed",
  denied: "Rejected at sign-off",
  aborted: "Stopped",
};
const instanceStatusLabel = (s: string) => INSTANCE_STATUS_LABEL[s] ?? humanize(s);

const ALIGNMENT_LABEL: Record<string, string> = {
  aligned: "Aligned",
  undershoot: "Grant gap",
  not_approved: "Not approved",
  no_intent_recorded: "No intent recorded",
};
function alignmentNote(status: string, useCaseStatus: UseCaseStatus): string {
  if (status === "not_approved")
    return useCaseStatus === "rejected"
      ? "Checked against approved intent only. This use case was rejected."
      : useCaseStatus === "retired"
        ? "Checked against approved intent only. This use case was retired."
        : "Checked against approved intent only. Nothing to check until it is approved.";
  if (status === "no_intent_recorded") return "No intended agents were named, so there is nothing to compare.";
  if (status === "undershoot") return "An intended agent is not granted to anyone on this use case — a provisioning gap, not evidence of use.";
  return "Every intended agent is granted to someone on this use case. This compares grants with intent, not traffic.";
}

const tagList = (tags: string[]) => tags.map(frameworkLabel).join(", ");
const capFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function UseCasePreviewDrawer(props: { id: string; row: UseCaseRow | undefined; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const agents = useAgents();
  const act = useAction();
  const detail = useQuery({
    queryKey: ["admin", "use-case", props.id],
    queryFn: () => api.get<UseCaseDetail>(`/v1/use-cases/${props.id}`),
  });
  const [intentDraft, setIntentDraft] = useState<string[] | null>(null);
  const [retireReason, setRetireReason] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const { onClose } = props;

  // a new record in the same drawer starts from its own stored intent
  useEffect(() => {
    setIntentDraft(null);
    setRetireReason("");
    heading.current?.focus();
  }, [props.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = detail.data;
  const u = d?.useCase;
  const name = u?.name ?? props.row?.name ?? "Use case";
  const status = (u?.status ?? props.row?.status) as UseCaseStatus | undefined;
  const refresh = async () => {
    await Promise.all([detail.refetch(), props.onChanged()]);
  };
  const conditions = d?.conditions ?? [];
  const openConditions = conditions.filter((c) => c.status === "open");
  const until = validity(u?.approvedUntil ?? props.row?.approvedUntil ?? null, u?.approvalExpired);

  return (
    <aside className={r.drawer} role="dialog" aria-modal="false" aria-labelledby="uc-preview-title">
      <div className={r.drawerHead}>
        <div className={r.drawerTitleBlock}>
          <span className={r.drawerType}>AI use case</span>
          <h2 id="uc-preview-title" ref={heading} tabIndex={-1} className={r.drawerTitle}>
            {name}
          </h2>
          {status && (
            <div className={v.row}>
              <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" className={r.close} onClick={props.onClose} aria-label="Close preview">
          Close
        </Button>
      </div>
      <div className={r.drawerBody}>
        <div className={r.drawerActions}>
          <Link to={`/admin/governance/use-cases/${props.id}`} className={`${k.btnPrimary} ${r.openLink}`}>
            Open use case
          </Link>
        </div>

        {detail.isLoading && <p className={v.faint}>Loading…</p>}
        {detail.error ? (
          <p className={v.errLine} role="alert">
            Couldn&apos;t load this use case — {(detail.error as Error).message}{" "}
            <Button size="sm" onClick={() => void detail.refetch()}>Retry</Button>
          </p>
        ) : null}

        {d && u && (
          <>
            {d.euAiActScreening.refusal && (
              <div role="alert" className={r.refusal}>
                <Badge tone="danger">Prohibited</Badge> {d.euAiActScreening.refusal}
              </div>
            )}
            <dl className={r.facts}>
              <dt>Owner</dt>
              <dd>{u.ownerName ?? props.row?.ownerName ?? shortId(u.ownerUserId)}</dd>
              <dt>Tier</dt>
              <dd>{u.euAiActTier ? <Badge tone={tierTone(u.euAiActTier)}>{tierLabel(u.euAiActTier)}</Badge> : <span className={v.faint}>Not screened</span>}</dd>
              <dt>Created</dt>
              <dd>{fmtDay(u.createdAt)}</dd>
              <dt>Valid until</dt>
              <dd className={until.expired ? r.expired : undefined}>{until.text}</dd>
              <dt>Open conditions</dt>
              <dd>
                {d.conditions === undefined
                  ? props.row?.openConditions ?? "—"
                  : openConditions.length === 0
                    ? "None"
                    : `${openConditions.length} (${openConditions.filter((c) => c.blocking).length} before go-live)`}
              </dd>
              <dt>Data sensitivity</dt>
              <dd>{humanize(u.dataSensitivity)}</dd>
              <dt>Frameworks</dt>
              <dd>{u.complianceTags.length ? tagList(u.complianceTags) : <span className={v.faint}>None</span>}</dd>
            </dl>

            <section className={r.section} aria-labelledby="uc-preview-purpose">
              <h3 id="uc-preview-purpose" className={r.sectionTitle}>Purpose</h3>
              <p className={r.prose}>{u.description || "—"}</p>
              {u.businessContext && u.businessContext !== u.description && (
                <>
                  <h3 className={r.sectionTitle}>Business context</h3>
                  <p className={r.prose}>{u.businessContext}</p>
                </>
              )}
            </section>

            {openConditions.length > 0 && (
              <section className={r.section} aria-labelledby="uc-preview-conditions">
                <h3 id="uc-preview-conditions" className={r.sectionTitle}>Open conditions</h3>
                {openConditions.map((c) => (
                  <div key={c.id} className={v.row}>
                    <Badge tone={c.blocking ? "warn" : "neutral"}>{c.blocking ? "Before go-live" : "After go-live"}</Badge>
                    <span className={v.dim}>
                      {c.text} · due {fmtDay(c.dueAt)}{c.ownerName ? ` · ${c.ownerName}` : ""}
                      {c.overdue ? " · overdue" : ""}
                    </span>
                  </div>
                ))}
              </section>
            )}

            <section className={r.section} aria-labelledby="uc-preview-screening">
              <h3 id="uc-preview-screening" className={r.sectionTitle}>EU AI Act screening</h3>
              {d.euAiActScreening.tier ? (
                <>
                  {(d.euAiActScreening.reasons ?? []).map((reason) => (
                    <div key={reason.ruleId} className={v.row}>
                      <Badge tone={tierTone(reason.tier as EuTier)}>{reason.ref}</Badge>
                      <span className={v.dim}>{capFirst(reason.reason)}</span>
                    </div>
                  ))}
                  {d.euAiActScreening.tier === "minimal" && <span className={v.faint}>No screening rule matched.</span>}
                  <span className={v.faint}>{d.euAiActScreening.disclaimer}</span>
                </>
              ) : (
                <span className={v.faint}>
                  {d.euAiActScreening.answersStatus === "invalid"
                    ? `Not screened — the screening answers could not be read: ${d.euAiActScreening.answersError}`
                    : "Not screened yet — the tier comes from the screening answers in the questionnaire."}
                </span>
              )}
            </section>

            {d.instance && (
              <section className={r.section} aria-labelledby="uc-preview-intake">
                <h3 id="uc-preview-intake" className={r.sectionTitle}>Intake</h3>
                <div className={v.row}>
                  {d.instance.stages.map((s) => (
                    <Badge key={s.id} tone={s.id === d.instance!.currentStageId ? "info" : "neutral"}>{humanize(s.id)}</Badge>
                  ))}
                </div>
                <span className={v.dim}>{instanceStatusLabel(d.instance.status)}</span>
                {d.instance.status === "blocked_on_plan" && (
                  <div>
                    <Button
                      size="sm"
                      disabled={act.busy}
                      onClick={() =>
                        void act.run(async () => {
                          await api.post(`/v1/workflows/instances/${d.instance!.id}/advance`, { stageId: "plan" });
                          await refresh();
                        }, "Planning finished — the questionnaire is next")
                      }
                    >
                      Finish planning
                    </Button>
                  </div>
                )}
                {d.instance.status === "blocked_on_artifact" && (
                  <span className={v.dim}>
                    The questionnaire is submitted from the <Link to={`/workflows/${d.instance.id}`}>intake workflow</Link>.
                  </span>
                )}
                {d.instance.status === "blocked_on_approval" && (
                  <span className={v.dim}>
                    Decided in the <Link to="/admin/approvals">Approvals queue</Link>.
                  </span>
                )}
              </section>
            )}

            {d.questionnaire && (
              <details className={`${r.section} ${r.details}`}>
                <summary>Questionnaire · version {d.questionnaire.version} · submitted {ago(d.questionnaire.createdAt)}</summary>
                <QuestionnaireView content={d.questionnaire.content} />
              </details>
            )}

            <section className={r.section} aria-labelledby="uc-preview-agents">
              <h3 id="uc-preview-agents" className={r.sectionTitle}>Intended agents</h3>
              {u.status === "proposed" || u.status === "under_review" || u.status === "needs_info" ? (
                <div className={v.stack}>
                  <Field label="Intended agents (ctrl/cmd-click to select several)">
                    <Select
                      multiple
                      size={Math.min(5, Math.max(3, (agents.data?.agents ?? []).length))}
                      value={intentDraft ?? u.intendedAgentIds}
                      onChange={(e) => setIntentDraft(Array.from(e.target.selectedOptions).map((o) => o.value))}
                    >
                      {(agents.data?.agents ?? []).map((ag) => (
                        <option key={ag.id} value={ag.id}>{ag.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <div>
                    <Button
                      size="sm"
                      disabled={act.busy || intentDraft === null}
                      onClick={() =>
                        void act.run(async () => {
                          await api.patch(`/v1/use-cases/${u.id}`, { intendedAgentIds: intentDraft ?? [] });
                          setIntentDraft(null);
                          await refresh();
                        }, "Intended agents captured — the alignment comparison reads exactly this list")
                      }
                    >
                      Save intended agents
                    </Button>
                  </div>
                </div>
              ) : (
                <span className={v.faint}>
                  {u.intendedAgentIds.length === 0
                    ? "No intended agents were recorded before the decision."
                    : "Part of what was decided — changing them means registering a new use case."}
                </span>
              )}
              <div className={v.row}>
                <Badge tone={d.intendedVsGranted.status === "aligned" ? "ok" : d.intendedVsGranted.status === "undershoot" ? "warn" : "neutral"}>
                  {ALIGNMENT_LABEL[d.intendedVsGranted.status] ?? humanize(d.intendedVsGranted.status)}
                </Badge>
                <span className={v.faint}>{alignmentNote(d.intendedVsGranted.status, u.status)}</span>
              </div>
              {(d.intendedVsGranted.agents ?? []).map((ag) => (
                <div key={ag.agentId} className={v.row}>
                  <Badge tone={ag.grantedToParticipants ? "ok" : "warn"}>{ag.agentName ?? shortId(ag.agentId)}</Badge>
                  <span className={v.faint}>
                    {ag.registered
                      ? ag.grantedToParticipants
                        ? `Granted to ${plural(ag.participantHolders, "participant")}`
                        : "Not granted to anyone on this use case"
                      : "No longer in the agent registry"}
                  </span>
                </div>
              ))}
            </section>

            <details className={`${r.section} ${r.details}`}>
              <summary>What the frameworks require</summary>
              <CascadeSummary d={d} />
            </details>

            {u.status !== "retired" && (
              <details className={`${r.section} ${r.details}`}>
                <summary>Retire this use case</summary>
                <div className={v.stack}>
                  <Field label="Reason for retiring (recorded in the audit log)">
                    <Input value={retireReason} onChange={(e) => setRetireReason(e.target.value)} placeholder="Superseded by a narrower use case" />
                  </Field>
                  <div>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={act.busy || !retireReason.trim()}
                      onClick={() =>
                        void act.run(async () => {
                          await api.post(`/v1/use-cases/${u.id}/retire`, { reason: retireReason.trim() });
                          setRetireReason("");
                          await refresh();
                        }, "Use case retired")
                      }
                    >
                      Retire use case
                    </Button>
                  </div>
                </div>
              </details>
            )}
            {u.status === "retired" && (
              <span className={v.faint}>Retired{u.retiredReason ? ` — ${u.retiredReason}` : ""}.</span>
            )}
            <span className={v.faint}>Registered {fmtAt(u.createdAt)}</span>
          </>
        )}
      </div>
    </aside>
  );
}

/** the compliance-tag consequences, derived live from the compliance profiles */
function CascadeSummary({ d }: { d: UseCaseDetail }) {
  const c = d.cascadeConsequences;
  if (d.useCase.complianceTags.length === 0) return <span className={v.faint}>No frameworks are attached, so nothing extra is required.</span>;
  return (
    <div className={v.stack}>
      {c.profiles.length === 0 ? (
        <span className={v.faint}>No compliance profile covers these frameworks yet, so they add no requirements.</span>
      ) : (
        c.combined && (
          <dl className={r.facts}>
            <dt>PII handling</dt>
            <dd>{piiLabel(c.combined.piiMode)}</dd>
            <dt>MCP tool access</dt>
            <dd>{mcpLabel(c.combined.mcpDefaultMode)}</dd>
            <dt>Audit retention</dt>
            <dd>{c.combined.auditRetentionDays == null ? "Organization default" : plural(c.combined.auditRetentionDays, "day")}</dd>
            <dt>Required stages</dt>
            <dd>{c.combined.forcedStageIds.map(humanize).join(", ") || "None"}</dd>
          </dl>
        )
      )}
      {c.unrecognizedTags.length > 0 && (
        <span className={v.faint}>No compliance profile defines {tagList(c.unrecognizedTags)} yet.</span>
      )}
      {c.project && (
        <span className={v.faint}>
          Project {c.project.name}
          {c.project.tagsNotCarried.length ? ` is not yet classified with ${tagList(c.project.tagsNotCarried)}.` : " carries these frameworks."}
        </span>
      )}
    </div>
  );
}

