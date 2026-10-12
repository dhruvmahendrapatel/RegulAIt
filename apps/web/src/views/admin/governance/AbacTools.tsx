/**
 * ADR-0040 — the three ABAC controls the policies page lacked:
 *
 *  - **Edit = a new version.** `POST /v1/abac/policies/:id/versions` never
 *    overwrites; the active version keeps enforcing until the new one is
 *    explicitly activated (and, where the deployment requires it, previewed).
 *  - **Simulate one request** (`POST /v1/abac/simulate`): what the ABAC layer
 *    would say about a hypothetical call, executing nothing. A `permit` there
 *    is never an allow, and the copy says so.
 *  - **Run every active policy's stored tests** (`POST /v1/abac/test`) — the
 *    same runner CI calls.
 */
import { useId, useState } from "react";
import { api } from "../../../api/client";
import type { AbacPolicySummary, AbacPolicyVersion } from "../../../api/adminTypes";
import { Badge, Button, Card, CodeBlock, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import {
  OutcomePanel,
  optionEls,
  projectOpts,
  serverOpts,
  useAction,
  useApiAction,
  useProjects,
  useServerTools,
  useServers,
  useUsers,
  userOpts,
} from "../adminKit";
import {
  ABAC_REFUSALS,
  EMPTY_SIMULATE_FORM,
  simulateBody,
  simulationSentence,
  validationErrorsOf,
  versionBody,
  versionFormFrom,
  type AbacMode,
  type AbacSimulation,
  type AbacSuiteRun,
  type SimulateForm,
  type VersionForm,
} from "./abacModel";
import { withRefusalCopy } from "./refusalCopy";
import { schemaNote } from "./abacModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

/** the "edit" form: every save is version N+1, inactive until activated */
export function AbacNewVersionForm(props: {
  policyId: string;
  policy: AbacPolicySummary | null;
  versions: readonly AbacPolicyVersion[];
  /** the attribute schema the gateway validates a new version against (its default) */
  currentSchema: string | null;
  onCreated: (version: number) => void;
}) {
  const users = useUsers();
  const act = useApiAction();
  const [form, setForm] = useState<VersionForm>(() => versionFormFrom(props.versions, props.policy));
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof VersionForm>(k: K, value: VersionForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };
  const ids = { intro: useId(), tests: useId(), problem: useId() };
  const errors = act.outcome && !act.outcome.ok ? validationErrorsOf(act.outcome.payload) : [];
  const mappedReason = act.outcome && !act.outcome.ok && act.outcome.code ? ABAC_REFUSALS[act.outcome.code] : undefined;

  return (
    <form
      aria-label="Add a policy version"
      aria-describedby={ids.intro}
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        const built = versionBody(form);
        if (!built.ok) {
          setProblem(built.problem);
          return;
        }
        void act
          .run(
            () =>
              api.post<{ version: AbacPolicyVersion }>(`/v1/abac/policies/${props.policyId}/versions`, built.body),
            "New version added — the active version keeps enforcing until you activate this one",
          )
          .then((out) => {
            if (out) props.onCreated(out.version.version);
          });
      }}
    >
      <p className={v.faint} id={ids.intro}>
        Saving adds the next version and leaves every earlier one untouched. Nothing changes for live calls until you
        activate the new version, and activation is a separate, audited step.
      </p>
      <p className={v.faint} data-testid="abac-version-schema">
        {schemaNote(props.versions, props.currentSchema)}
      </p>
      <div className={a.formRow}>
        <Field label="When it matches">
          <Select value={form.mode} onChange={(e) => set("mode", e.target.value as AbacMode)}>
            <option value="forbid">Deny the call</option>
            <option value="require_approval">Pause for approval</option>
          </Select>
        </Field>
        <Field label="Timezone the policy reads times in">
          <Input required value={form.timezone} onChange={(e) => set("timezone", e.target.value)} placeholder="UTC" />
        </Field>
        {form.mode === "require_approval" && (
          <Field label="Approver for paused calls">
            <Select required value={form.approverUserId} onChange={(e) => set("approverUserId", e.target.value)}>
              {optionEls(userOpts(users.data?.users), "— who signs off —")}
            </Select>
          </Field>
        )}
      </div>
      <Field label="Cedar policy (new version)" grow>
        <Textarea
          required
          rows={10}
          spellCheck={false}
          value={form.source}
          onChange={(e) => set("source", e.target.value)}
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        />
      </Field>
      <Field label="Stored test cases (JSON array, optional)" grow>
        <Textarea
          rows={6}
          spellCheck={false}
          aria-describedby={ids.tests}
          value={form.testCases}
          onChange={(e) => set("testCases", e.target.value)}
          placeholder='[{"name": "night write is denied", "principal": {}, "resource": {"toolName": "write_record", "kind": "write"}, "expect": "match"}]'
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        />
      </Field>
      <p className={v.faint} id={ids.tests}>
        Each case names a principal, a resource and whether the policy should match. They run with “Run tests” on the
        version and in CI. Leave empty to store none.
      </p>
      <div className={v.row}>
        <Button type="submit" variant="primary" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
          Save as new version
        </Button>
      </div>
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      <OutcomePanel outcome={act.outcome} testId="abac-version-outcome">
        {mappedReason ? <p className={v.dim}>{mappedReason}</p> : null}
        {errors.length > 0 && (
          <ul className={v.stackTight} data-testid="abac-version-errors">
            {errors.map((e, i) => (
              <li key={i}>
                {e.message}
                {e.help ? ` — ${e.help}` : ""}
              </li>
            ))}
          </ul>
        )}
      </OutcomePanel>
    </form>
  );
}

/** "what would the ABAC layer say about this call?" — executes nothing */
export function AbacSimulateCard() {
  const users = useUsers();
  const servers = useServers();
  const projects = useProjects();
  const act = useAction();
  const [form, setForm] = useState<SimulateForm>(EMPTY_SIMULATE_FORM);
  const tools = useServerTools(form.serverId || null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<AbacSimulation | null>(null);
  const set = <K extends keyof SimulateForm>(k: K, value: SimulateForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };
  const ids = { intro: useId(), at: useId(), problem: useId() };

  return (
    <Card title="Simulate a request against the active policies">
      <p className={v.faint} id={ids.intro}>
        Answers what the ABAC layer would decide for one hypothetical call. Nothing is executed and nothing is queued.
        The environment and deploy mode come from the project you name, exactly as enforcement derives them; they
        cannot be typed in.
      </p>
      <form
        aria-label="Simulate an ABAC request"
        aria-describedby={ids.intro}
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const built = simulateBody(form);
          if (!built.ok) {
            setProblem(built.problem);
            return;
          }
          setResult(null);
          void act.run(
            () =>
              withRefusalCopy(async () => {
                setResult(await api.post<AbacSimulation>("/v1/abac/simulate", built.body));
              }, ABAC_REFUSALS),
            null,
          );
        }}
      >
        <Field label="As user">
          <Select required value={form.userId} onChange={(e) => set("userId", e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select a user —")}
          </Select>
        </Field>
        <Field label="MCP server">
          <Select
            required
            value={form.serverId}
            onChange={(e) => {
              set("serverId", e.target.value);
              set("toolName", "");
            }}
          >
            {optionEls(serverOpts(servers.data?.servers), "— select a server —")}
          </Select>
        </Field>
        <Field label="Tool">
          <Select required value={form.toolName} onChange={(e) => set("toolName", e.target.value)}>
            {optionEls(
              (tools.data?.tools ?? []).map((t) => ({ v: t.name, l: `${t.name} (${t.kind})` })),
              "— select a tool —",
            )}
          </Select>
        </Field>
        <Field label="Project (optional)">
          <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "— no project —")}
          </Select>
        </Field>
        <Field label="At (optional, your local time)">
          <Input type="datetime-local" value={form.at} aria-describedby={ids.at} onChange={(e) => set("at", e.target.value)} />
        </Field>
        <Field label="Session origin (optional)">
          <Input value={form.sessionOrigin} onChange={(e) => set("sessionOrigin", e.target.value)} placeholder="web" />
        </Field>
        <Field label="MFA completed">
          <Select value={form.mfa} onChange={(e) => set("mfa", e.target.value as SimulateForm["mfa"])}>
            <option value="">Not stated</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
          Simulate
        </Button>
      </form>
      <p className={v.faint} id={ids.at}>
        Leave the time empty to evaluate at the current moment. A hypothetical time is a simulation input only;
        enforcement never accepts a caller's clock.
      </p>
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
      <div aria-live="polite" data-testid="abac-simulation">
        {result && (
          <div className={v.stack}>
            <div className={v.row}>
              <Badge tone={result.abacDecision?.effect === "forbid" ? "danger" : result.abacDecision?.effect === "require_approval" ? "warn" : "neutral"}>
                {result.abacDecision ? result.abacDecision.effect.replaceAll("_", " ") : "no ABAC input"}
              </Badge>
              <span>{simulationSentence(result)}</span>
            </div>
            {result.abacDecision?.reason ? <p className={v.dim}>{result.abacDecision.reason}</p> : null}
            <p className={v.faint}>{result.note}</p>
            <Table
              rows={result.activePolicies}
              rowKey={(p) => p.id}
              empty={<span className={v.faint}>No active policies.</span>}
              columns={[
                { key: "name", header: "Active policy", render: (p) => p.name },
                { key: "version", header: "Version", render: (p) => `v${p.version}` },
                { key: "mode", header: "On match", render: (p) => (p.mode === "require_approval" ? "pause for approval" : "deny") },
                { key: "tz", header: "Timezone", render: (p) => p.timezone },
              ]}
            />
            <details>
              <summary className={v.dim} style={{ cursor: "pointer" }}>
                The attributes enforcement would evaluate
              </summary>
              <CodeBlock maxHeight="280px">{JSON.stringify(result.attributes, null, 2)}</CodeBlock>
            </details>
          </div>
        )}
      </div>
    </Card>
  );
}

/** the CI runner: every ACTIVE policy's stored tests, at its active version */
export function AbacSuiteCard() {
  const act = useAction();
  const [run, setRun] = useState<AbacSuiteRun | null>(null);
  return (
    <Card
      title="Tests of every active policy"
      actions={
        <Button
          size="sm"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              const out = await api.post<AbacSuiteRun>("/v1/abac/test", {});
              setRun(out);
              return `${out.passed} passed, ${out.failed} failed across ${out.policies.length} active ${out.policies.length === 1 ? "policy" : "policies"}`;
            })
          }
        >
          Run all active tests
        </Button>
      }
    >
      <p className={v.faint}>
        The same runner CI calls. Each active policy is tested at the version that is enforcing now; a policy with no
        stored cases reports zero of zero.
      </p>
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <div aria-live="polite" data-testid="abac-suite">
        {run && (
          <div className={v.stack}>
            <div className={v.row}>
              <Badge tone={run.failed === 0 ? "ok" : "danger"}>
                {run.passed} passed · {run.failed} failed
              </Badge>
              {run.policies.length === 0 && <span className={v.faint}>No policy is active, so there is nothing to test.</span>}
            </div>
            {run.policies.map((p) => (
              <div key={p.policyId} className={v.stackTight}>
                <div className={v.row}>
                  <strong>{p.name}</strong>
                  <span className={v.mono}>v{p.version}</span>
                  <Badge tone={p.failed === 0 ? "ok" : "danger"}>
                    {p.passed}/{p.passed + p.failed} passed
                  </Badge>
                </div>
                {p.results
                  .filter((r) => !r.passed)
                  .map((r, i) => (
                    <div key={i} className={v.row}>
                      <Badge tone="danger">fail</Badge>
                      <span>{r.name}</span>
                      <span className={v.faint}>
                        expected {r.expected}, got {r.actual}
                      </span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
