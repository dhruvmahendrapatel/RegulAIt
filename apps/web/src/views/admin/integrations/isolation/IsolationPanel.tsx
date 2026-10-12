/**
 * ADR-0190 slice I9: execution profiles, executors and placement decisions on
 * the Engines page (Integrations; ADR-0177 §3, no new navigation group), and
 * the execution profile control on the agent builder and the MCP server page.
 *
 * Honest about what the gateway serves (isolationModel.ts):
 *  - Executors are live (I3) and shown with the gateway's own freshness verdict.
 *  - Profiles and placements answer 501 until slice I2. The cards say so and
 *    show nothing invented. A success body is not decoded either: its shape is
 *    not frozen, so the card says this console cannot read it yet.
 *  - No route assigns a profile to an agent or an MCP server, so the selector
 *    is disabled and says why.
 */
import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api/client";
import { ago, fmtAt } from "../../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table } from "../../../../ui/kit";
import { useAction } from "../../adminKit";
import {
  availabilityOf,
  BACKEND_CLASSES,
  BACKENDS,
  classText,
  executorReading,
  MISMATCH_TEXT,
  parseExecutors,
  registerBody,
  REFUSAL_REASONS,
  REFUSAL_TEXT,
  type Availability,
  type Backend,
  type Executor,
  type RegisterDraft,
} from "./isolationModel";
import { ExecutorDetail } from "./ExecutorDetail";
import v from "../../../views.module.css";

const isolationKeys = {
  profiles: ["admin", "isolation", "execution-profiles"] as const,
  executors: ["admin", "isolation", "executors"] as const,
  placements: ["admin", "isolation", "execution-placements"] as const,
};

function unavailableText(what: string, a: Availability): string {
  if (a.kind === "not_built") return `This gateway has not built ${what} yet (it answers 501, not built). Nothing is shown rather than an invented value.`;
  if (a.kind === "forbidden") return `You are not allowed to read ${what}.`;
  return `${what[0]!.toUpperCase()}${what.slice(1)} could not be read: ${a.message}`;
}

/** a read whose success body is not frozen yet: only its failure is interpreted */
function useUndecodedRead(queryKey: readonly string[], path: string) {
  return useQuery({ queryKey, retry: false, queryFn: () => api.get<unknown>(path) });
}

function UndecodedCard(props: { title: string; what: string; intro: string; q: ReturnType<typeof useUndecodedRead>; children?: React.ReactNode }) {
  const { q } = props;
  const body = q.isPending
    ? "Loading…"
    : q.isError
      ? unavailableText(props.what, availabilityOf(q.error))
      : `The gateway answered, but this console cannot read ${props.what} yet. Nothing is shown rather than a guessed value.`;
  return (
    <Card
      title={props.title}
      actions={
        <Button size="sm" variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
          Check again
        </Button>
      }
    >
      <div className={v.stack}>
        <p className={v.dim}>{props.intro}</p>
        <EmptyState title={q.isPending ? `Loading ${props.what}` : `${props.what[0]!.toUpperCase()}${props.what.slice(1)} unavailable`} body={body} />
        {props.children}
      </div>
    </Card>
  );
}

export function IsolationPanel() {
  const profiles = useUndecodedRead(isolationKeys.profiles, "/v1/execution-profiles");
  const placements = useUndecodedRead(isolationKeys.placements, "/v1/execution-placements");
  return (
    <>
      <UndecodedCard
        title="Execution profiles"
        what="execution profiles"
        intro="A profile fixes a workload's filesystem, network, process and resource controls, and the probes its sandbox must report before it receives input. A missing profile makes a call unavailable; it never falls back to a weaker one."
        q={profiles}
      />
      <ExecutorsCard />
      <UndecodedCard
        title="Placement decisions"
        what="placement decisions"
        intro="Every isolable call is placed on an executor at or above its required class, or refused before any upstream contact with 409 execution_profile_unavailable and one fixed reason. There is no fallback to a lower class."
        q={placements}
      >
        <RefusalReasons />
      </UndecodedCard>
    </>
  );
}

function RefusalReasons() {
  return (
    <div>
      <h3 className={v.sectionTitle}>What each refusal reason means</h3>
      <dl className={v.stackTight}>
        {REFUSAL_REASONS.map((reason) => (
          <div key={reason}>
            <dt>
              <code>{reason}</code>
            </dt>
            <dd className={v.dim}>{REFUSAL_TEXT[reason]}</dd>
          </div>
        ))}
        <div>
          <dt>
            <code>execution_profile_mismatch</code>
          </dt>
          <dd className={v.dim}>{MISMATCH_TEXT}</dd>
        </div>
      </dl>
    </div>
  );
}

type ExecutorRow = Executor | { unreadable: true; index: number };
const rowKey = (r: ExecutorRow) => ("unreadable" in r ? `unreadable-${r.index}` : r.id);

function ExecutorsCard() {
  const [registering, setRegistering] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const q = useQuery({ queryKey: isolationKeys.executors, retry: false, refetchInterval: 60_000, queryFn: () => api.get<unknown>("/v1/executors") });
  // re-judge on this screen so a report never stays green past its expiry
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const rows = q.data === undefined ? null : parseExecutors(q.data);
  const failure = q.isError ? unavailableText("executors", availabilityOf(q.error)) : rows === null && !q.isPending ? "The gateway's executor list could not be read. No placement assurance is shown." : null;
  // registering is offered only against a list that was read: never blind, and never where the read was refused
  const registerReasonId = useId();
  const registerBlocked = failure
    ? `Registering an executor is unavailable while the executor list cannot be read. ${failure}`
    : q.isPending
      ? "Registering an executor is available once the executor list has loaded."
      : null;
  return (
    <>
    <Card
      title="Executors"
      actions={
        <>
          <Button size="sm" variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
            Check again
          </Button>
          <Button
            size="sm"
            disabled={registerBlocked !== null}
            aria-describedby={registerBlocked ? registerReasonId : undefined}
            onClick={() => setRegistering(true)}
          >
            Register executor
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.dim}>
          Executors are the only things that start sandboxes. A class counts only while the executor holds a fresh, passing
          self-test for it. Every report is software-attested by the executor on its own host: a compromised host can lie, so this
          is never hardware verification.
        </p>
        {registerBlocked && (
          <p id={registerReasonId} className={v.dim}>
            {registerBlocked}
          </p>
        )}
        {failure ? (
          <EmptyState title="Executors unavailable" body={failure} />
        ) : (
          <Table<ExecutorRow>
            rows={rows ?? []}
            rowKey={rowKey}
            loading={q.isPending}
            columns={[
              { key: "name", header: "Executor", render: (r) => ("unreadable" in r ? "Unreadable record" : r.name) },
              { key: "backend", header: "Backend · runtime", render: (r) => ("unreadable" in r ? "Not reported" : `${r.backend} · ${r.runtimeVersion}`) },
              {
                key: "classes",
                header: "Expected classes",
                render: (r) => ("unreadable" in r ? "Not reported" : r.classesDeclared.length ? r.classesDeclared.map(classText).join(", ") : "None"),
              },
              {
                key: "attestation",
                header: "Attestation",
                render: (r) => {
                  if ("unreadable" in r)
                    return (
                      <span>
                        <Badge tone="neutral">Unmeasured</Badge> <span className={v.faint}>The gateway sent a record this console cannot read.</span>
                      </span>
                    );
                  const reading = executorReading(r, now);
                  return (
                    <span>
                      <Badge tone={reading.tone}>{reading.state}</Badge> <span className={v.faint}>{reading.detail}</span>
                    </span>
                  );
                },
              },
              {
                key: "seen",
                header: "Last seen",
                render: (r) => ("unreadable" in r || r.lastSeenAt === null ? "Never" : <span title={fmtAt(new Date(r.lastSeenAt).toISOString())}>{ago(new Date(r.lastSeenAt).toISOString())}</span>),
              },
              { key: "open", header: "Open work", render: (r) => ("unreadable" in r ? "Not reported" : String(r.openOffers)) },
              {
                // ADR-0190 I3: detail, self-test history and the lifecycle acts
                key: "manage",
                header: "",
                align: "right",
                render: (r) =>
                  "unreadable" in r ? null : (
                    <Button size="sm" variant="ghost" aria-label={`Manage executor ${r.name}`} aria-pressed={managing === r.id} onClick={() => setManaging(managing === r.id ? null : r.id)}>
                      Manage
                    </Button>
                  ),
              },
            ]}
            empty={<EmptyState title="No executors registered" body="With no executor, every isolable call is refused (no_executor). Nothing runs with weaker isolation instead." />}
          />
        )}
      </div>
      {registering && <RegisterExecutorDialog onClose={() => setRegistering(false)} />}
    </Card>
    {managing && <ExecutorDetail key={managing} executorId={managing} onClose={() => setManaging(null)} />}
    </>
  );
}

/**
 * `POST /v1/executors`: bind one active `worker_runtime` identity to a name, a
 * backend and the classes it is expected to attest. Registering grants no
 * class: each one counts only once the executor passes a self-test for it, so
 * this is not a relaxation and needs no step-up. The gateway audits it.
 */
function RegisterExecutorDialog(props: { onClose: () => void }) {
  const act = useAction();
  const [draft, setDraft] = useState<RegisterDraft>({ workloadIdentityId: "", name: "", backend: "", runtimeVersion: "", classesDeclared: [] });
  const [problem, setProblem] = useState<string | null>(null);
  const formId = useId();
  const identityHelpId = useId();
  const submit = async () => {
    const out = registerBody(draft);
    if ("error" in out) return setProblem(out.error);
    setProblem(null);
    if (await act.run(() => api.post("/v1/executors", out.body), `Executor ${out.body.name} registered`)) props.onClose();
  };
  const allowed = draft.backend ? BACKEND_CLASSES[draft.backend] : [];
  return (
    <Modal
      open
      title="Register an executor"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" disabled={act.busy}>
            Register
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className={v.dim}>
          Registering grants no isolation class. Each class counts only once the executor passes a self-test for it, and every
          report is software-attested. The gateway records the registration in its audit log.
        </p>
        <Field label="Worker identity id">
          <Input
            value={draft.workloadIdentityId}
            maxLength={36}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={identityHelpId}
            onChange={(e) => setDraft({ ...draft, workloadIdentityId: e.target.value.trim() })}
          />
        </Field>
        <p id={identityHelpId} className={v.dim}>
          The id of the active worker_runtime workload identity the executor authenticates as, from its enrolment. The gateway refuses
          any other kind of identity, or one that is not in service.
        </p>
        <Field label="Executor name">
          <Input value={draft.name} maxLength={63} autoComplete="off" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Backend">
          <Select
            value={draft.backend}
            onChange={(e) => setDraft({ ...draft, backend: e.target.value as Backend | "", classesDeclared: [] })}
          >
            <option value="">Choose a backend</option>
            {BACKENDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Runtime version">
          <Input value={draft.runtimeVersion} maxLength={128} autoComplete="off" onChange={(e) => setDraft({ ...draft, runtimeVersion: e.target.value })} />
        </Field>
        <fieldset className={v.stackTight}>
          <legend>Classes it is expected to attest</legend>
          {allowed.length === 0 && <p className={v.dim}>Choose a backend to see the classes it can attest.</p>}
          {allowed.map((c) => (
            <label key={c} className={v.rowTight}>
              <input
                type="checkbox"
                checked={draft.classesDeclared.includes(c)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    classesDeclared: e.target.checked ? [...draft.classesDeclared, c] : draft.classesDeclared.filter((x) => x !== c),
                  })
                }
              />
              <span>{classText(c)}</span>
            </label>
          ))}
        </fieldset>
        {(problem ?? act.error) && <p role="alert">{problem ?? act.error}</p>}
      </form>
    </Modal>
  );
}

/**
 * Where an agent or a local MCP server would pick its execution profile. The
 * gateway has no route to assign one, and the profile list is not built yet,
 * so the control is disabled and says why. It never shows a choice it cannot
 * save, and it never picks a weaker profile on its own.
 */
export function ExecutionProfileSelector(props: { context: string }) {
  const reasonId = useId();
  return (
    <div className={v.stackTight} data-testid="execution-profile-selector">
      <Field label={`Execution profile · ${props.context}`}>
        <Select disabled value="" aria-describedby={reasonId} onChange={() => undefined}>
          <option value="">Not available yet</option>
        </Select>
      </Field>
      <p id={reasonId} className={v.dim}>
        Assigning an execution profile is not available yet: this gateway has no route to assign one, and it does not serve the
        profile list (it answers 501, not built). Nothing is selected here, and no weaker profile is ever chosen on your behalf.
      </p>
    </div>
  );
}
