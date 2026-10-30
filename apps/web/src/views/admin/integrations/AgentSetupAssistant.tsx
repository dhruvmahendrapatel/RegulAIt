/**
 * ADR-0205 — the agent setup assistant on the Register an agent card. It ships
 * in the lazy admin-integrations route chunk, so the entry bundle carries none of it.
 *
 * The admin describes the agent; the gateway returns a draft (rules always, a
 * governed model draft when asked). "Use this draft in the form" only fills the register
 * form: nothing is saved until the admin presses Register. Grants, approvals,
 * budget and the model card are shown as recommendations for their own cards.
 * The assistant is off until an admin turns it on (a step-up, audited).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Button, Field, Select, Textarea } from "../../../ui/kit";
import { agentOpts, optionEls, useAction, useAgents } from "../adminKit";
import { putOrgSettings } from "../../../stepup/stepUp";
import v from "../../views.module.css";

type Source = "rules" | "model" | "mock";
interface DraftField<T> {
  value: T;
  source: Source;
  why?: string;
}
export interface AgentSetupDraft {
  name: DraftField<string>;
  tier: DraftField<number>;
  systemPrompt: DraftField<string>;
  purpose: DraftField<string>;
  riskTier: DraftField<"minimal" | "limited" | "high">;
  grants: DraftField<string>;
  approvalRule: DraftField<string>;
  monthlyBudgetUsd: DraftField<number>;
  intendedUse: DraftField<string>;
  limitations: DraftField<string>;
}
type ModelDraft =
  | { status: "not_requested" }
  | { status: "skipped" | "refused" | "failed" | "unparseable"; reason: string }
  | { status: "drafted"; source: "model" | "mock"; agentId: string; fields: string[] };
export interface AssistResponse {
  draft: AgentSetupDraft;
  model: ModelDraft;
  disclaimer: string;
}

const STATUS_KEY = ["agent-setup-assist"] as const;

/** the draft's rows: [label, field]; the first five fill the form, the rest are set on their own cards */
const ROWS: Array<[string, keyof AgentSetupDraft]> = [
  ["Name", "name"],
  ["Purpose", "purpose"],
  ["Tier", "tier"],
  ["System prompt", "systemPrompt"],
  ["Risk tier", "riskTier"],
  ["Grants", "grants"],
  ["Approval rule", "approvalRule"],
  ["Monthly budget per user (USD)", "monthlyBudgetUsd"],
  ["Intended use", "intendedUse"],
  ["Limitations", "limitations"],
];

export default function AgentSetupAssistant(props: { onUse: (draft: AgentSetupDraft) => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.get<{ enabled: boolean; connectedProviders: string[] }>("/v1/agents/setup-assist"),
  });
  const agents = useAgents();
  const act = useAction();
  const [description, setDescription] = useState("");
  const [withModel, setWithModel] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [result, setResult] = useState<AssistResponse | null>(null);
  const errorLine = act.error && (
    <span className={v.errLine} role="alert">
      {act.error}
    </span>
  );

  if (!status.data) return status.error ? <p className={v.errLine} role="alert">Assistant unavailable.</p> : null;

  if (!status.data.enabled) {
    return (
      <div className={v.stack}>
        <p className={v.faint}>The setup assistant is off. It drafts a configuration for you to review; nothing applies without your confirmation.</p>
        <div className={v.row}>
          <Button
            type="button"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(() => putOrgSettings({ agentSetupAssistEnabled: true }), "Setup assistant turned on")
                .then((ok) => {
                  if (ok) void qc.invalidateQueries({ queryKey: STATUS_KEY });
                })
            }
          >
            Turn on the setup assistant
          </Button>
          {errorLine}
        </div>
      </div>
    );
  }

  const connected = status.data.connectedProviders.length > 0;

  return (
    <div className={v.stack}>
      <Field label="What is the agent for, what data does it see, what may it do?">
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className={v.row}>
        <label>
          <input
            type="checkbox"
            checked={withModel}
            disabled={!connected}
            onChange={(e) => setWithModel(e.target.checked)}
          />{" "}
          Also draft with a governed model
        </label>
        {withModel && (
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Model to draft with">
            {optionEls(agentOpts(agents.data?.agents), "Agent builder default")}
          </Select>
        )}
      </div>
      {!connected && <p className={v.faint}>Add a model credential to draft with a model.</p>}
      <div className={v.row}>
        <Button
          type="button"
          disabled={act.busy || description.trim().length < 10}
          onClick={() =>
            void act.run(async () => {
              setResult(
                await api.post<AssistResponse>("/v1/agents/setup-assist", {
                  description,
                  ...(withModel ? { draftWithModel: true, ...(agentId ? { agentId } : {}) } : {}),
                }),
              );
            }, null)
          }
        >
          Draft configuration
        </Button>
        {errorLine}
      </div>

      {result && <DraftResultView result={result} onUse={props.onUse} />}
    </div>
  );
}

/** the draft and any model refusal, inline; rendering it never applies anything */
export function DraftResultView(props: { result: AssistResponse; onUse: (draft: AgentSetupDraft) => void }) {
  const { draft, model } = props.result;
  return (
    <>
      {model.status !== "not_requested" && model.status !== "drafted" && (
        <p className={v.errLine} role="alert" data-testid="agent-setup-assist-refusal">
          Model draft {model.status}: {model.reason}
        </p>
      )}

      <div className={v.stack} data-testid="agent-setup-assist-draft">
        {ROWS.map(([label, key]) => {
          const field = draft[key];
          return (
            <div key={key}>
              <strong>{label}</strong> <Badge tone={field.source === "rules" ? "neutral" : "info"}>{field.source}</Badge>
              <div style={{ whiteSpace: "pre-wrap" }}>{String(field.value)}</div>
              {field.why && <div className={v.faint}>{field.why}</div>}
            </div>
          );
        })}
        <p className={v.faint}>{props.result.disclaimer}</p>
        <div className={v.row}>
          <Button type="button" variant="primary" onClick={() => props.onUse(draft)}>
            Use this draft in the form
          </Button>
        </div>
      </div>
    </>
  );
}
