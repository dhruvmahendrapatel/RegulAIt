/**
 * ADR-0190 slice I9: execution profiles, executors and placement decisions on
 * the Engines page (Integrations; ADR-0177 §3, no new navigation group), and
 * the execution profile control on the agent builder and the MCP server page.
 *
 * Honest about what the gateway serves (isolationModel.ts):
 *  - Executors are live (I3) and shown with the gateway's own freshness verdict.
 *  - Profiles and placements are live (I2): every version with the fields it
 *    loosens against `restricted`, and every placement decision, including the
 *    refusals decided before a placement row could exist (`policy_unresolved`).
 *  - The selector assigns a profile to an agent or a stdio MCP server (I2). A
 *    looser profile is a relaxation: the gateway asks for the step-up.
 *  Anything the gateway sends that cannot be read is shown as unreadable, never
 *  as a default or an empty list.
 */
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api/client";
import { ago, fmtAt } from "../../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../../stepup/stepUp";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table } from "../../../../ui/kit";
import { useAction } from "../../adminKit";
import {
  assignableProfiles,
  availabilityOf,
  CLASSES,
  isClass,
  newProfileBody,
  profileNameOk,
  versionBody,
  BACKEND_CLASSES,
  BACKENDS,
  classText,
  executorReading,
  MISMATCH_TEXT,
  parseAssignment,
  parseExecutors,
  parseWorkerIdentities,
  parsePlacements,
  parseProfiles,
  profileText,
  registerBody,
  REFUSAL_REASONS,
  REFUSAL_TEXT,
  refusalText,
  REQUIRED_BY_TEXT,
  type AssignmentTargetKind,
  type Availability,
  type Backend,
  type Executor,
  type Placement,
  type ProfileVersion,
  type RegisterDraft,
  type UnrecordedRefusal,
} from "./isolationModel";
// loaded on first Manage: the Engines page does not pay for the lifecycle surface until it is used
const ExecutorDetail = lazy(() => import("./ExecutorDetail").then((m) => ({ default: m.ExecutorDetail })));
import v from "../../../views.module.css";

const isolationKeys = {
  profiles: ["admin", "isolation", "execution-profiles"] as const,
  executors: ["admin", "isolation", "executors"] as const,
  placements: ["admin", "isolation", "execution-placements"] as const,
  assignment: (kind: string, id: string) => ["admin", "isolation", "assignment", kind, id] as const,
};

function unavailableText(what: string, a: Availability): string {
  if (a.kind === "not_built") return `This gateway has not built ${what} yet (it answers 501, not built). Nothing is shown rather than an invented value.`;
  if (a.kind === "forbidden") return `You are not allowed to read ${what}.`;
  return `${what[0]!.toUpperCase()}${what.slice(1)} could not be read: ${a.message}`;
}

export function IsolationPanel() {
  return (
    <>
      <ProfilesCard />
      <ExecutorsCard />
      <PlacementsCard />
    </>
  );
}

type Unreadable = { unreadable: true; index: number };
const isUnreadable = (r: object): r is Unreadable => "unreadable" in r;
const unreadableKey = (r: Unreadable) => `unreadable-${r.index}`;

function ReadFailure(props: { what: string; q: { isError: boolean; error: unknown; isPending: boolean }; parsed: unknown }) {
  const { q } = props;
  if (q.isError) return <EmptyState title={`${props.what[0]!.toUpperCase()}${props.what.slice(1)} unavailable`} body={unavailableText(props.what, availabilityOf(q.error))} />;
  if (!q.isPending && props.parsed === null)
    return <EmptyState title={`${props.what[0]!.toUpperCase()}${props.what.slice(1)} unavailable`} body={`The gateway's ${props.what} could not be read. Nothing is shown rather than a guessed value.`} />;
  return null;
}

type ProfileRow = ProfileVersion | Unreadable;

function ProfilesCard() {
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: isolationKeys.profiles, retry: false, queryFn: () => api.get<unknown>("/v1/execution-profiles") });
  const rows = q.data === undefined ? null : parseProfiles(q.data);
  const failed = q.isError || (!q.isPending && rows === null);
  const createReasonId = useId();
  return (
    <Card
      title="Execution profiles"
      actions={
        <>
          <Button size="sm" variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
            Check again
          </Button>
          <Button size="sm" disabled={failed || q.isPending} aria-describedby={failed ? createReasonId : undefined} onClick={() => setCreating(true)}>
            New profile
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.dim}>
          A profile fixes a workload's filesystem, network, process and resource controls, and the probes its sandbox must report before it
          receives input. Each version is immutable; a change is a new version. A retired profile makes its calls unavailable; it never falls
          back to a weaker one.
        </p>
        {failed && (
          <p id={createReasonId} className={v.dim}>
            Creating a profile is unavailable while the profile list cannot be read.
          </p>
        )}
        {creating && rows && <NewProfileDialog profiles={assignableProfiles(rows)} onClose={() => setCreating(false)} />}
        {failed ? (
          <ReadFailure what="execution profiles" q={q} parsed={rows} />
        ) : (
          <Table<ProfileRow>
            rows={rows ?? []}
            rowKey={(r) => (isUnreadable(r) ? unreadableKey(r) : r.id)}
            loading={q.isPending}
            columns={[
              {
                key: "name",
                header: "Profile",
                render: (r) =>
                  isUnreadable(r) ? (
                    "Unreadable record"
                  ) : (
                    <span>
                      {r.name} v{r.version} {r.shipped && <Badge tone="neutral">Shipped</Badge>}
                    </span>
                  ),
              },
              { key: "class", header: "Minimum class", render: (r) => (isUnreadable(r) ? "Not reported" : classText(r.minClass)) },
              {
                key: "status",
                header: "Status",
                render: (r) =>
                  isUnreadable(r) ? <Badge tone="neutral">Unmeasured</Badge> : r.retiredAt !== null ? <Badge tone="danger">Retired</Badge> : <Badge tone="ok">Live</Badge>,
              },
              {
                key: "relaxed",
                header: "Looser than restricted",
                render: (r) => (isUnreadable(r) ? "Not reported" : r.relaxations.length === 0 ? "None" : r.relaxations.join(", ")),
              },
              { key: "digest", header: "Digest", render: (r) => (isUnreadable(r) ? "Not reported" : <code title={r.digest}>{r.digest.slice(0, 12)}</code>) },
            ]}
            empty={<EmptyState title="No execution profiles" body="The gateway reported no profiles, so every isolable call is refused." />}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * `POST /v1/execution-profiles`: a new profile copied from a live version, renamed, at a chosen minimum class. A
 * field looser than `restricted` (a lower class, or a looser base) is a relaxation: the gateway asks for the
 * step-up and audits it. Its other controls are edited by API (a new version per change).
 */
function NewProfileDialog(props: { profiles: ProfileVersion[]; onClose: () => void }) {
  const act = useAction();
  const formId = useId();
  const [baseId, setBaseId] = useState(props.profiles.find((p) => p.name === "restricted")?.id ?? props.profiles[0]?.id ?? "");
  const [name, setName] = useState("");
  const [minClass, setMinClass] = useState<string>("");
  const [problem, setProblem] = useState<string | null>(null);
  const base = props.profiles.find((p) => p.id === baseId) ?? null;
  const submit = async () => {
    if (!base) return setProblem("Choose a profile to start from.");
    if (!profileNameOk(name)) return setProblem("Name: 2 to 63 characters, lower-case letters, digits and hyphens, starting with a letter.");
    if (!isClass(minClass)) return setProblem("Choose the minimum isolation class.");
    setProblem(null);
    const ok = await act.run(async () => {
      const detail = await api.get<unknown>(`/v1/execution-profiles/${encodeURIComponent(base.name)}`);
      const body = newProfileBody(versionBody(detail, base.id), name, minClass);
      if (!body) throw new Error("The base profile's body could not be read. Nothing was created.");
      return withStepUp((h) => stepUpApi.post("/v1/execution-profiles", { body }, h));
    }, `Execution profile ${name} created`);
    if (ok) props.onClose();
  };
  return (
    <Modal
      open
      title="New execution profile"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" disabled={act.busy}>
            Create
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
          The new profile copies every control of the one it starts from. A lower class than the strict reference is an audited relaxation and
          needs a step-up.
        </p>
        <Field label="Start from">
          <Select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            {props.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileText(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Profile name">
          <Input value={name} maxLength={63} autoComplete="off" onChange={(e) => setName(e.target.value.trim())} />
        </Field>
        <Field label="Minimum isolation class">
          <Select value={minClass} onChange={(e) => setMinClass(e.target.value)}>
            <option value="">Choose a class</option>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {classText(c)}
              </option>
            ))}
          </Select>
        </Field>
        {(problem ?? act.error) && <p role="alert">{problem ?? act.error}</p>}
      </form>
    </Modal>
  );
}

type PlacementRow = Placement | Unreadable;

function outcomeBadge(p: Placement) {
  if (p.outcome === "placed") return <Badge tone="ok">Placed</Badge>;
  if (p.outcome === "mismatch") return <Badge tone="danger">Mismatch</Badge>;
  return <Badge tone="warn">Refused</Badge>;
}

function PlacementsCard() {
  const q = useQuery({ queryKey: isolationKeys.placements, retry: false, queryFn: () => api.get<unknown>("/v1/execution-placements?limit=50") });
  const parsed = q.data === undefined ? null : parsePlacements(q.data);
  const failed = q.isError || (!q.isPending && parsed === null);
  return (
    <Card
      title="Placement decisions"
      actions={
        <Button size="sm" variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
          Check again
        </Button>
      }
    >
      <div className={v.stack}>
        <p className={v.dim}>
          Every isolable call is placed on an executor at or above its required class, or refused before any upstream contact with 409
          execution_profile_unavailable and one fixed reason. There is no fallback to a lower class. Evidence is software-attested.
        </p>
        {failed ? (
          <ReadFailure what="placement decisions" q={q} parsed={parsed} />
        ) : (
          <>
            <Table<PlacementRow>
              rows={parsed?.placements ?? []}
              rowKey={(r) => (isUnreadable(r) ? unreadableKey(r) : r.id)}
              loading={q.isPending}
              columns={[
                { key: "at", header: "When", render: (r) => (isUnreadable(r) ? "Not reported" : <span title={fmtAt(new Date(r.createdAt).toISOString())}>{ago(new Date(r.createdAt).toISOString())}</span>) },
                { key: "kind", header: "Workload", render: (r) => (isUnreadable(r) ? "Unreadable record" : r.workloadKind) },
                {
                  key: "required",
                  header: "Required",
                  render: (r) => (isUnreadable(r) ? "Not reported" : `${classText(r.requiredClass)}, set by ${REQUIRED_BY_TEXT[r.requiredBy] ?? r.requiredBy}`),
                },
                { key: "outcome", header: "Outcome", render: (r) => (isUnreadable(r) ? <Badge tone="neutral">Unmeasured</Badge> : outcomeBadge(r)) },
                {
                  key: "detail",
                  header: "Reason or placement",
                  render: (r) =>
                    isUnreadable(r) ? (
                      "Not reported"
                    ) : r.outcome === "placed" ? (
                      `${classText(r.appliedClass)} on ${r.executorName ?? "an executor"}`
                    ) : (
                      <span>
                        <code>{r.refusalCode}</code> <span className={v.faint}>{refusalText(r.refusalCode)}</span>
                      </span>
                    ),
                },
              ]}
              empty={<EmptyState title="No placement decisions yet" body="No isolable call has been placed or refused." />}
            />
            {parsed && parsed.unrecorded.length > 0 && <UnrecordedRefusals rows={parsed.unrecorded} />}
          </>
        )}
        <RefusalReasons />
      </div>
    </Card>
  );
}

function UnrecordedRefusals(props: { rows: Array<UnrecordedRefusal | Unreadable> }) {
  return (
    <div>
      <h3 className={v.sectionTitle}>Refused before any placement</h3>
      <p className={v.dim}>A policy fact did not resolve, or the profile digest named no profile: refused before any executor was offered work.</p>
      <ul className={v.stackTight}>
        {props.rows.map((r) =>
          isUnreadable(r) ? (
            <li key={unreadableKey(r)}>Unreadable record</li>
          ) : (
            <li key={r.auditId}>
              <code>{r.code ?? "not reported"}</code>
              {r.unresolvedFact && <span className={v.faint}> · the fact {r.unresolvedFact} did not resolve</span>}
              <span className={v.faint}> · {ago(new Date(r.at).toISOString())}</span>
            </li>
          ),
        )}
      </ul>
    </div>
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
                header: "Manage",
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
    {managing && (
      <Suspense fallback={<p role="status">Loading the executor…</p>}>
        <ExecutorDetail key={managing} executorId={managing} onClose={() => setManaging(null)} />
      </Suspense>
    )}
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
  // ADR-0188 S6: the worker_runtime identities to choose from (no free-text id)
  const sources = useQuery({ queryKey: ["admin", "identity", "picker-sources"], retry: false, queryFn: () => api.get<unknown>("/v1/identity/picker-sources") });
  const workers = sources.data === undefined ? null : parseWorkerIdentities(sources.data);
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
        <Field label="Worker identity">
          <Select
            value={draft.workloadIdentityId}
            disabled={workers === null}
            aria-describedby={identityHelpId}
            onChange={(e) => setDraft({ ...draft, workloadIdentityId: e.target.value })}
          >
            <option value="">{workers === null ? "Not available" : workers.options.length === 0 ? "No worker identity to choose" : "Choose a worker identity"}</option>
            {(workers?.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <p id={identityHelpId} className={v.dim}>
          {sources.isPending
            ? "Loading the worker identities…"
            : workers === null
              ? sources.isError
                ? unavailableText("worker identities", availabilityOf(sources.error))
                : "The gateway's worker identities could not be read, so none can be chosen."
              : `The active worker_runtime workload identity the executor authenticates as (enrol it under Workload identities first). The gateway refuses any other kind of identity, or one that is not in service.${workers.truncated ? " The list is cut short: not every identity is shown." : ""}`}
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
 * Where an agent or a local MCP server picks its execution profile (decision 7
 * item 5): `PUT /v1/execution-profile-assignments/:kind/:id`. Choosing a
 * profile looser than the one in force (or than `restricted`) is a
 * relaxation: the gateway asks for a step-up, and audits every assignment. It
 * never picks a profile on its own, and an unknown agent still runs only under
 * the most restrictive profile whatever is assigned here.
 */
export function ExecutionProfileSelector(props: { context: string; targetKind: AssignmentTargetKind; targetId: string }) {
  const reasonId = useId();
  const act = useAction();
  const assignment = useQuery({
    queryKey: isolationKeys.assignment(props.targetKind, props.targetId),
    retry: false,
    queryFn: () => api.get<unknown>(`/v1/execution-profile-assignments/${props.targetKind}/${encodeURIComponent(props.targetId)}`),
  });
  const profiles = useQuery({ queryKey: isolationKeys.profiles, retry: false, queryFn: () => api.get<unknown>("/v1/execution-profiles") });
  const current = assignment.data === undefined ? null : parseAssignment(assignment.data);
  const list = profiles.data === undefined ? null : parseProfiles(profiles.data);
  const [draft, setDraft] = useState<string | null>(null);
  const loading = assignment.isPending || profiles.isPending;
  const blocked = assignment.isError
    ? unavailableText("this assignment", availabilityOf(assignment.error))
    : profiles.isError
      ? unavailableText("execution profiles", availabilityOf(profiles.error))
      : !loading && (current === null || list === null)
        ? "The gateway's answer could not be read, so nothing is selected and nothing can be saved."
        : null;
  const options = list ? assignableProfiles(list) : [];
  const value = draft ?? current?.assigned?.id ?? "";
  const changed = current !== null && value !== (current.assigned?.id ?? "");
  const save = async () => {
    const ok = await act.run(
      () => withStepUp((h) => stepUpApi.put(`/v1/execution-profile-assignments/${props.targetKind}/${encodeURIComponent(props.targetId)}`, { profileId: value === "" ? null : value }, h)),
      "Execution profile saved",
    );
    if (ok) {
      setDraft(null);
      await assignment.refetch();
    }
  };
  const describedBy = blocked || loading ? reasonId : undefined;
  return (
    <div className={v.stackTight} data-testid="execution-profile-selector">
      <Field label={`Execution profile · ${props.context}`}>
        <Select disabled={blocked !== null || loading || act.busy} value={value} aria-describedby={describedBy} onChange={(e) => setDraft(e.target.value)}>
          <option value="">Shipped default · restricted</option>
          {options
            .filter((o) => !o.shipped || o.name !== "restricted")
            .map((o) => (
              <option key={o.id} value={o.id}>
                {profileText(o)}
              </option>
            ))}
          {current?.assigned && !options.some((o) => o.id === current.assigned!.id) && <option value={current.assigned.id}>{`${profileText(current.assigned)} (retired)`}</option>}
        </Select>
      </Field>
      {blocked || loading ? (
        <p id={reasonId} className={v.dim}>
          {blocked ?? "Loading the profile in force…"}
        </p>
      ) : (
        <p className={v.dim}>
          In force: {current ? `${profileText(current.effective)} (${current.source === "assigned" ? "assigned" : "the shipped default"})` : "not reported"}. A
          looser profile is an audited relaxation that needs a step-up.
        </p>
      )}
      {changed && (
        <div>
          <Button size="sm" variant="primary" disabled={act.busy} onClick={() => void save()}>
            Save execution profile
          </Button>
        </div>
      )}
      {act.error && <p role="alert">{act.error}</p>}
    </div>
  );
}
