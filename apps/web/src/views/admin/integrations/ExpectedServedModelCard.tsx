/**
 * ADR-0175 — an agent's EXPECTED served model (`PUT /v1/agents/:agentId/
 * expected-served-model`, admin only, audited with both values).
 *
 * Served-model drift compares the model an endpoint reports serving with what
 * was expected. By default (the strict value) that is the agent's configured
 * model id. An endpoint whose configured id is a deployment name reports the
 * model behind it, so without this every call reads as drift. Setting it
 * changes what counts as drift, so it is confirmed and says so, and the gateway
 * asks for a `settings_relax` step-up; clearing it returns to the strict
 * default and asks for nothing. Nothing about the call itself changes.
 */
import { useId, useState } from "react";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { AdminAgent } from "../../../api/adminTypes";
import { Button, Card, ConfirmModal, Field, Input, Select } from "../../../ui/kit";
import { agentOpts, optionEls, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const EXPECTED_SERVED_MODEL_MAX = 200;

/** the body to send: a trimmed id of 1 to 200 characters, or null to clear */
export function expectedServedModelBody(raw: string): { error: string } | { body: { expectedServedModel: string | null } } {
  const value = raw.trim();
  if (value === "") return { body: { expectedServedModel: null } };
  if (value.length > EXPECTED_SERVED_MODEL_MAX) return { error: `The model id must be at most ${EXPECTED_SERVED_MODEL_MAX} characters.` };
  return { body: { expectedServedModel: value } };
}

export function ExpectedServedModelCard(props: { agents: AdminAgent[] }) {
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const helpId = useId();
  const agent = props.agents.find((x) => x.id === agentId);
  const stored = agent?.expectedServedModel ?? null;
  const save = (body: { expectedServedModel: string | null }) =>
    void act.run(
      // setting it is a relaxation the gateway confirms with a step-up (settings_relax); clearing it asks nothing
      () => withStepUp((h) => stepUpApi.put(`/v1/agents/${agentId}/expected-served-model`, body, h)),
      body.expectedServedModel === null
        ? "Expected served model cleared: drift is measured against the configured model again"
        : `Expected served model set to ${body.expectedServedModel}`,
    );
  return (
    <Card title="Expected served model — drift baseline">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const out = expectedServedModelBody(value);
          if ("error" in out) return setProblem(out.error);
          setProblem(null);
          if (out.body.expectedServedModel === null) save(out.body);
          else setConfirm(out.body.expectedServedModel);
        }}
      >
        <Field label="Agent" grow>
          <Select
            required
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setValue(props.agents.find((x) => x.id === e.target.value)?.expectedServedModel ?? "");
              setProblem(null);
            }}
          >
            {optionEls(agentOpts(props.agents), "— select an agent —")}
          </Select>
        </Field>
        <Field label="Expected served model (empty = the configured model)">
          <Input value={value} maxLength={EXPECTED_SERVED_MODEL_MAX} aria-describedby={helpId} onChange={(e) => setValue(e.target.value)} disabled={!agentId} />
        </Field>
        <Button type="submit" disabled={act.busy || !agentId || value.trim() === (stored ?? "")}>
          {value.trim() === "" ? "Clear expected model" : "Save expected model"}
        </Button>
        {(problem ?? act.error) && (
          <span className={v.errLine} role="alert">
            {problem ?? act.error}
          </span>
        )}
      </form>
      <p id={helpId} className={v.faint}>
        {agent
          ? stored
            ? `Now: drift is measured against ${stored}. The configured model id is ${agent.model ?? "not set"}.`
            : `Now: drift is measured against the configured model id (${agent.model ?? "not set"}), the strict default.`
          : "Pick an agent to see what its served-model drift is measured against."}{" "}
        Use this only when the endpoint's configured id is a deployment name that reports a different underlying model. A change is refused while an
        incident evidence hold covers the agent, and every change is audited with both values.
      </p>
      <ConfirmModal
        open={confirm !== null}
        title="Change what counts as served-model drift?"
        confirmLabel="Set expected model"
        body={
          <p>
            Calls to {agent?.name ?? "this agent"} that report serving <code>{confirm}</code> will no longer raise served-model drift, even though its
            configured model id is {agent?.model ? <code>{agent.model}</code> : "not set"}. This relaxes the strict default; clearing the field restores it.
            The change is audited.
          </p>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) save({ expectedServedModel: c });
        }}
      />
    </Card>
  );
}
