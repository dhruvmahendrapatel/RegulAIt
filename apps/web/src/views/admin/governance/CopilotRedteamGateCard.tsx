/**
 * ADR-0056 §5 amendment — the copilot narrator red-team gate (`GET/PUT /v1/copilot/redteam-gate`).
 *
 * Strict by default: an agent narrates a copilot answer only after a passing red-team run on the one designated
 * library. Loosening anything (off, a longer window, a lower floor, fewer trials, any library change) is an audited
 * relaxation, so the form names what it loosens in a confirmation and the gateway asks the admin to confirm it is them
 * (a `settings_relax` step-up). Below the settings, "Check an agent" asks the gateway, for one agent, whether it may
 * narrate now and which run decided it; it is read only when an agent is chosen.
 *
 * The rules are in `copilotRedteamGateModel.ts`.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, Field, Input, Select, SkeletonBlock } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { QueryGate, useAction, useAgents } from "../adminKit";
import {
  gateBody,
  gateFormFrom,
  gateState,
  REDTEAM_GATE_BOUNDS,
  REDTEAM_GATE_REFUSALS,
  type GateBody,
  type GateForm,
  type RedteamGateSettings,
  type RedteamGateStatus,
} from "./copilotRedteamGateModel";
import { refusalSentence, withRefusalCopy } from "./refusalCopy";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "copilot-redteam-gate"] as const;

interface Library {
  id: string;
  name: string;
  version: number;
  status: "draft" | "published" | "retired";
}

export function CopilotRedteamGateCard() {
  const gate = useQuery({ queryKey: KEY, queryFn: () => stepUpApi.get<RedteamGateStatus>("/v1/copilot/redteam-gate") });
  const libraries = useQuery({
    queryKey: ["admin", "redteam-libraries"],
    queryFn: () => api.get<{ libraries: Library[] }>("/v1/redteam/libraries"),
  });
  return (
    <Card title="Narrator red-team gate">
      <QueryGate query={gate}>
        {gate.data?.settings ? (
          <div className={v.stack}>
            <GateEditor
              key={JSON.stringify(gate.data.settings)}
              current={gate.data.settings}
              libraries={libraries.data?.libraries ?? []}
              librariesLoading={libraries.isLoading}
              onSaved={() => void gate.refetch()}
            />
            <AgentCheck />
          </div>
        ) : gate.data ? (
          <p className={v.faint}>This gateway does not report the narrator red-team gate.</p>
        ) : null}
      </QueryGate>
    </Card>
  );
}

function GateEditor(props: { current: RedteamGateSettings; libraries: Library[]; librariesLoading: boolean; onSaved: () => void }) {
  const current = props.current;
  const act = useAction();
  const [form, setForm] = useState<GateForm>(() => gateFormFrom(current));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ body: GateBody; relaxes: string[] } | null>(null);
  const ids = { age: useId(), floor: useId(), trials: useId(), problem: useId() };
  const set = <K extends keyof GateForm>(k: K, value: GateForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };
  const state = gateState(current);
  // a published library decides; the current one stays listed even if it was retired since
  const choices = props.libraries.filter((l) => l.status === "published" || l.id === current.libraryId);

  const save = (body: GateBody) =>
    void act
      .run(
        () => withRefusalCopy(() => withStepUp((h) => stepUpApi.put("/v1/copilot/redteam-gate", body, h)), REDTEAM_GATE_REFUSALS),
        body.enabled === false ? "Saved: the gate is off, so any agent may narrate. The change is audited." : "Narrator red-team gate saved",
      )
      .then((ok) => {
        if (ok) props.onSaved();
      });

  return (
    <form
      aria-label="Narrator red-team gate settings"
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        const built = gateBody(form, current);
        if (!built.ok) return setProblem(built.problem);
        if (Object.keys(built.body).length === 0) return setProblem("Nothing has changed.");
        if (built.relaxes.length > 0) setConfirm({ body: built.body, relaxes: built.relaxes });
        else save(built.body);
      }}
    >
      <div className={v.row}>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <p className={v.faint}>
        An agent narrates a copilot answer only after a passing run on the chosen library. The run must have answered and
        resisted every required class ({current.requiredClasses.join(", ")}), use the model and system prompt the agent
        serves now, and be recent enough. Without a narrator, the copilot still gives its grounded answer.
      </p>
      <label className={v.rowTight}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span>Hold narration until the agent passes the red-team run (recommended)</span>
      </label>
      <Field label="Deciding library" help="Only a published red-team library can decide. With none chosen, no agent may narrate.">
        <Select value={form.libraryId} onChange={(e) => set("libraryId", e.target.value)} disabled={props.librariesLoading}>
          <option value="">None chosen (no agent may narrate)</option>
          {choices.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} v{l.version}
              {l.status !== "published" ? ` (${l.status})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <div className={a.formRow}>
        <Field label="Window (days)" help="How old the deciding run may be.">
          <Input inputMode="numeric" value={form.maxAgeDays} aria-describedby={ids.age} onChange={(e) => set("maxAgeDays", e.target.value)} />
        </Field>
        <Field label="Floor (% resisted)" help="The share of probes resisted, in every required class.">
          <Input inputMode="numeric" value={form.minResistPercent} aria-describedby={ids.floor} onChange={(e) => set("minResistPercent", e.target.value)} />
        </Field>
        <Field label="Trials per probe" help="How many times each probe must have been tried.">
          <Input inputMode="numeric" value={form.minTrials} aria-describedby={ids.trials} onChange={(e) => set("minTrials", e.target.value)} />
        </Field>
      </div>
      <p className={v.faint}>
        <span id={ids.age}>Window: 1 to {REDTEAM_GATE_BOUNDS.maxAgeDays} days.</span> <span id={ids.floor}>Floor: 0 to 100%.</span>{" "}
        <span id={ids.trials}>Trials: 1 to {REDTEAM_GATE_BOUNDS.maxTrials}.</span> Loosening any of these, or changing the library,
        asks you to confirm it is you.
      </p>
      <div className={v.row}>
        <Button type="submit" variant="primary" busy={act.busy} disabled={act.busy} title={act.busy ? "Saving…" : undefined}>
          Save gate settings
        </Button>
      </div>
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <RefusalNotice guidance={act.guidance} />
      <ConfirmModal
        open={confirm !== null}
        danger
        title="Loosen the narrator red-team gate?"
        confirmLabel="Save and confirm it's me"
        body={
          <>
            <p>This change:</p>
            <ul>
              {confirm?.relaxes.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p>It is recorded in the audit trail, and you will be asked to confirm it is you.</p>
          </>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) save(c.body);
        }}
      />
    </form>
  );
}

/** for one agent: may it narrate now, and which run decided it (read only once an agent is chosen) */
function AgentCheck() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState("");
  const verdict = useQuery({
    queryKey: [...KEY, "agent", agentId],
    queryFn: () => stepUpApi.get<RedteamGateStatus>(`/v1/copilot/redteam-gate?agentId=${encodeURIComponent(agentId)}`),
    enabled: agentId !== "",
    retry: false,
  });
  const v1 = verdict.data?.verdict;
  return (
    <section className={v.stackTight} aria-labelledby="redteam-gate-check">
      <h3 id="redteam-gate-check" className={v.sectionTitle}>
        Check an agent
      </h3>
      <Field label="Agent">
        <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agents.isLoading}>
          <option value="">Choose an agent</option>
          {(agents.data?.agents ?? []).map((ag) => (
            <option key={ag.id} value={ag.id}>
              {ag.name}
            </option>
          ))}
        </Select>
      </Field>
      {agentId === "" ? (
        <p className={v.faint}>Choose an agent to see whether it may narrate now.</p>
      ) : verdict.isLoading ? (
        <SkeletonBlock lines={2} />
      ) : verdict.error ? (
        <p className={v.errLine} role="alert">
          {refusalSentence(verdict.error, REDTEAM_GATE_REFUSALS) ?? "The check could not be made. Try again in a moment."}
        </p>
      ) : v1 ? (
        <div className={v.stackTight} role="status">
          <div>
            <Badge tone={v1.allowed ? "ok" : "warn"}>{v1.allowed ? "May narrate" : "Held"}</Badge>
          </div>
          <p>{v1.reason}</p>
          <p className={v.faint}>{v1.runId ? `Decided by red-team run ${v1.runId}.` : "No red-team run decided this."}</p>
        </div>
      ) : null}
    </section>
  );
}
