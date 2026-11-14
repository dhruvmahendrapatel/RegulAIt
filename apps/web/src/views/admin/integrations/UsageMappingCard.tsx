/**
 * ADR-0241 (P21) — "Usage counts — custom mapping", on the Agents page (owner-approved on #453, 2026-11-07).
 *
 * For a provider whose response the built-in adapter does not read, an admin maps where its token counts are, tests
 * the mapping against a sample response with the exact counts it should give, and activates the tested version.
 * Every route here is admin-only (apps/gateway/src/usage-extractors.ts), and the whole Agents page sits behind
 * RequireAdmin, so no one else sees this card.
 *
 *   - Off by default (ADR-0180). Turning the org switch on and activating a version are `settings_relax` step-ups;
 *     turning it off and deactivating return to the built-in counts and ask for nothing.
 *   - Activate is disabled, with its reason beside it, until the version's latest test passed. The gateway checks
 *     again and answers 409 `sample_test_required` before it asks for the step-up, so the grant is never spent.
 *   - The fallback count: the audit log records each fallback (`usage-extractor-fallback`), but no audit read counts
 *     rows by rule, so the tile says "not measured" and links to the audit log. It is never shown as 0.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import type { AdminAgent } from "../../../api/adminTypes";
import type { UsageExtractorState, UsageExtractorTestResult, UsageExtractorVersion, UsageExtractorVersions, UsageField } from "../../../api/types";
import { fmtDay } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Fieldset, InfoButton, Input, RowActions, Select, Skeleton, SkeletonBlock, Switch, Table, Textarea } from "../../../ui/kit";
import { agentOpts, optionEls, useApiAction, useUsers, type ApiOutcome } from "../adminKit";
import {
  FIELD_LABEL,
  MAIN_FIELDS,
  MORE_FIELDS,
  REQUIRED_FIELDS,
  SAMPLE_MAX_LABEL,
  USAGE_FIELDS,
  activation,
  buildMapping,
  buildTestBody,
  draftFrom,
  emptyList,
  failureText,
  fieldsMappedLabel,
  mappedFields,
  mappingErrors,
  refusalText,
  testRows,
  type ListDraft,
  type MappingDraft,
} from "./usageMappingModel";
import u from "./usageMapping.module.css";

const KEY = ["admin", "usage-extractors"] as const;
const versionsKey = (agentId: string) => ["admin", "usage-extractor-versions", agentId] as const;
const fmtCount = (n: number) => n.toLocaleString("en-GB");

/** a refusal from one of the card's writes, inline beside the action (the toast also says it, but disappears) */
function Refusal(props: { outcome: ApiOutcome | null; version?: number; lead?: string }) {
  const o = props.outcome;
  if (!o || o.ok) return null;
  const known = refusalText(o.code, o.status, props.version !== undefined ? { version: props.version } : {});
  const errors = mappingErrors(o.payload);
  if (known) {
    return (
      <div className={`${u.notice} ${u.warn}`} role="alert">
        <strong>{known.title}</strong> {known.body}
      </div>
    );
  }
  return (
    <div className={`${u.notice} ${u.danger}`} role="alert">
      <strong>{props.lead ?? "Refused."}</strong> {errors.length ? null : o.reason}
      {errors.length > 0 && (
        <ul>
          {errors.map((e, i) => (
            <li key={`${i}-${e}`}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function UsageMappingCard(props: { agents: AdminAgent[] }) {
  const [agentId, setAgentId] = useState("");
  const [editing, setEditing] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const state = useQuery({ queryKey: KEY, queryFn: () => api.get<UsageExtractorState>("/v1/usage-extractors") });
  const versions = useQuery({
    queryKey: versionsKey(agentId),
    queryFn: () => api.get<UsageExtractorVersions>(`/v1/agents/${agentId}/usage-extractor/versions`),
    enabled: agentId !== "",
  });
  const users = useUsers();
  const switchAct = useApiAction();
  const rowAct = useApiAction();
  const [rowVersion, setRowVersion] = useState<number | undefined>(undefined);

  const agent = props.agents.find((x) => x.id === agentId);
  const name = agent?.name ?? "this agent";
  const enabled = state.data?.enabled === true;
  const list: UsageExtractorVersion[] = Array.isArray(versions.data?.versions) ? versions.data.versions : [];
  const activeId = versions.data?.activeVersionId ?? null;
  const active = list.find((x) => x.id === activeId) ?? null;
  const activeRow = (Array.isArray(state.data?.active) ? state.data.active : []).find((x) => x.agentId === agentId) ?? null;
  const nameOf = (id: string | null | undefined) => {
    const p = (users.data?.users ?? []).find((x) => x.id === id);
    return p ? p.displayName || p.email : null;
  };
  const testing = list.find((x) => x.id === testingId) ?? null;
  const nextVersion = (list[0]?.version ?? 0) + 1;

  const setSwitch = (next: boolean) =>
    void switchAct.run(
      // the gateway asks for a settings_relax step-up only when turning it ON; off returns to the built-in counts
      () => withStepUp((h) => stepUpApi.put("/v1/usage-extractors/enabled", { enabled: next }, h)),
      next ? "Custom usage mappings turned on" : "Custom usage mappings turned off: every agent uses its built-in counts",
    );
  const activate = (v: UsageExtractorVersion) => {
    setRowVersion(v.version);
    void rowAct.run(
      () => withStepUp((h) => stepUpApi.post(`/v1/agents/${agentId}/usage-extractor/versions/${v.id}/activate`, {}, h)),
      `Version ${v.version} activated for ${name}`,
    );
  };
  const deactivate = () => {
    setRowVersion(undefined);
    void rowAct.run(
      () => stepUpApi.post(`/v1/agents/${agentId}/usage-extractor/deactivate`, {}),
      `${name} is counted by its built-in adapter again`,
    );
  };

  const switchBox = state.isPending ? (
    <Skeleton width="14rem" height="24px" />
  ) : state.isError ? null : (
    <div className={u.switchBox}>
      <div className={u.switchRow}>
        <span id="usage-switch-label">Use custom mappings</span>
        <Switch checked={enabled} onChange={setSwitch} labelledBy="usage-switch-label" describedBy="usage-switch-note" busy={switchAct.busy} />
      </div>
      <p id="usage-switch-note" className={u.switchNote}>
        {enabled
          ? "On: an agent with an active version is counted by it. Who turned it on, and the step-up, are recorded in the audit log."
          : "Off: every agent is counted by its adapter's built-in extraction. You can save and test versions while it is off; none is used until you turn it on. Turning it on asks for a step-up and is recorded."}
      </p>
    </div>
  );

  let body: ReactNode;
  if (!agentId) body = <p className={u.lead}>Pick an agent to see how its usage is counted.</p>;
  else if (versions.isPending) body = <SkeletonBlock lines={4} />;
  else if (versions.isError)
    body = (
      <ErrorState
        title={`Couldn't load the versions for ${name}`}
        message="The fallback count is unknown, never 0, until this loads."
        onRetry={() => void versions.refetch()}
      />
    );
  else if (list.length === 0 && !editing)
    body = (
      <EmptyState
        title={`${name} is counted by its built-in adapter`}
        body="Add a mapping only if this agent's provider reports usage somewhere the adapter does not read."
        action={
          <Button variant="primary" onClick={() => (setEditing(true), setTestingId(null))}>
            New version
          </Button>
        }
      />
    );
  else
    body = (
      <>
        {list.length > 0 && (
          <div className={u.versions}>
            <p className={u.versionsHead} id="usage-versions-head">
              Versions for {name} <span>· saved versions never change; a new mapping is a new version</span>
            </p>
            <Table
              rows={list}
              rowKey={(x) => x.id}
              columns={[
                {
                  key: "version",
                  header: "Version",
                  render: (x) => (
                    <span>
                      {x.version} {x.id === activeId && <Badge tone="info">Active</Badge>}
                    </span>
                  ),
                },
                { key: "fields", header: "Fields mapped", render: (x) => fieldsMappedLabel(x.mapping) },
                {
                  key: "test",
                  header: "Latest sample test",
                  render: (x) =>
                    !x.latestTest ? (
                      <Badge>Not tested</Badge>
                    ) : x.latestTest.passed ? (
                      <span>
                        <Badge tone="ok">✓ Passed</Badge> <span className={u.nowrap}>{fmtDay(x.latestTest.testedAt)}</span>
                      </span>
                    ) : (
                      <span>
                        <Badge tone="danger">✕ Failed</Badge> {failureText(x.latestTest.failure)}
                      </span>
                    ),
                },
                { key: "saved", header: "Saved", render: (x) => <span className={u.nowrap}>{fmtDay(x.createdAt)}</span> },
                {
                  key: "actions",
                  header: "",
                  srHeader: "Actions",
                  align: "right",
                  render: (x) => {
                    const gate = activation(x);
                    const whyId = `usage-why-${x.id}`;
                    return (
                      <div className={u.actions}>
                        {/* the kit's fixed slots (X7): Activate always in the primary slot, Deactivate in the last */}
                        <RowActions
                          slot="6rem"
                          primary={
                            x.id === activeId ? null : (
                              <Button
                                size="sm"
                                busy={!gate.allowed || rowAct.busy}
                                aria-describedby={gate.reason ? whyId : undefined}
                                aria-label={`Activate version ${x.version}`}
                                onClick={() => activate(x)}
                              >
                                Activate
                              </Button>
                            )
                          }
                          secondary={
                            <Button size="sm" onClick={() => (setTestingId(x.id), setEditing(false))} aria-label={`${x.latestTest ? "Test again" : "Run a sample test"}: version ${x.version}`}>
                              {x.latestTest ? "Test again" : "Run a sample test"}
                            </Button>
                          }
                          rest={
                            x.id === activeId ? (
                              <Button size="sm" variant="danger" busy={rowAct.busy} onClick={deactivate} aria-label={`Deactivate version ${x.version}`}>
                                Deactivate
                              </Button>
                            ) : null
                          }
                        />
                        {x.id !== activeId && gate.reason && (
                          <span id={whyId} className={u.why}>
                            {gate.reason}
                          </span>
                        )}
                      </div>
                    );
                  },
                },
              ]}
            />
          </div>
        )}
        <Refusal outcome={rowAct.outcome} version={rowVersion} />
        {!editing && (
          <div className={u.footRow}>
            {/* one primary at a time: while a test panel is open its "Activate version N…" is the primary action */}
            <Button variant={testing ? "default" : "primary"} onClick={() => (setEditing(true), setTestingId(null))}>
              New version
            </Button>
            <span className={u.lead}>Activating a version needs a step-up (re-enter your second factor) and is recorded in the audit log.</span>
          </div>
        )}
        {(editing || testing) && (
          <div className={u.editor}>
            {editing && (
              <MappingEditor
                key={`${agentId}-${nextVersion}`}
                agentId={agentId}
                version={nextVersion}
                startFrom={list[0] ?? null}
                onCancel={() => setEditing(false)}
                onSaved={(id) => (setEditing(false), setTestingId(id))}
              />
            )}
            {testing && (
              <TestPanel
                key={testing.id}
                agentId={agentId}
                version={testing}
                isActive={testing.id === activeId}
                replaces={active && active.id !== testing.id ? active.version : null}
                onClose={() => setTestingId(null)}
              />
            )}
          </div>
        )}
      </>
    );

  const since = activeRow?.activatedAt ? ` · active since ${fmtDay(activeRow.activatedAt)}` : "";
  const by = nameOf(activeRow?.activatedBy) ? `, by ${nameOf(activeRow?.activatedBy)}` : "";
  return (
    <Card
      title="Usage counts — custom mapping"
      info={
        <p>
          A mapping is a JSON pointer into the provider's response for each count (or a sum of pointers, or a sum over a list). It never runs code.
          Each save is a new version that cannot change; it is used only after a sample test passed, it was activated with a step-up, and the switch
          is on. Every save, test, activation and switch change is recorded in the audit log.
        </p>
      }
    >
      <div className={u.body}>
        <div className={u.head}>
          <p className={u.lead}>
            For a provider whose response the built-in adapter does not read, map where its token counts are. The mapped counts price each call. If a
            mapping cannot read a response, the call keeps the built-in counts and the fallback is recorded in the audit log.
          </p>
          {switchBox}
        </div>
        {state.isError && (
          <ErrorState title="Couldn't load the usage-mapping switch" message="Whether custom mappings are on is unknown until this loads." onRetry={() => void state.refetch()} />
        )}
        <Refusal outcome={switchAct.outcome} lead="Not changed." />

        <div className={u.pickRow}>
          <Field label="Agent">
            <Select
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setEditing(false);
                setTestingId(null);
                rowAct.setOutcome(null);
              }}
            >
              {optionEls(agentOpts(props.agents), "— select an agent —")}
            </Select>
          </Field>
          {agentId && (
            <>
              <div className={u.tile}>
                <span className={u.tileLabel}>Counting with</span>
                <span className={u.tileValue} data-testid="usage-counting-with">
                  {versions.isPending ? (
                    <Skeleton width="10rem" />
                  ) : versions.isError ? (
                    "unknown"
                  ) : active ? (
                    <>
                      Version {active.version}{" "}
                      <span>
                        {since}
                        {by}
                        {enabled ? "" : " · not used while the switch is off"}
                      </span>
                    </>
                  ) : (
                    "The built-in adapter"
                  )}
                </span>
              </div>
              <div className={u.tile}>
                <span className={u.tileLabel}>
                  Fallbacks, last 7 days{" "}
                  <InfoButton label="the fallback count">
                    Each call a mapping could not read is recorded in the audit log under the rule usage-extractor-fallback. No audit read counts rows by
                    rule yet, so this is not measured rather than shown as 0.
                  </InfoButton>
                </span>
                <span className={u.tileValue} data-testid="usage-fallbacks">
                  not measured{" "}
                  <span>
                    · <Link to="/admin/audit">view in audit log</Link>
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
        {body}
      </div>
    </Card>
  );
}

function MappingEditor(props: {
  agentId: string;
  version: number;
  startFrom: UsageExtractorVersion | null;
  onCancel: () => void;
  onSaved: (versionId: string) => void;
}) {
  const [draft, setDraft] = useState<MappingDraft>(() => draftFrom(props.startFrom?.mapping));
  const [problems, setProblems] = useState<string[]>([]);
  const save = useApiAction();
  const setSource = (f: UsageField, value: string) => setDraft((d) => ({ ...d, sources: { ...d.sources, [f]: value } }));
  const setList = (i: number, patch: Partial<ListDraft>) =>
    setDraft((d) => ({ ...d, lists: d.lists.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const addList = () => setDraft((d) => ({ ...d, lists: [...d.lists, emptyList()] }));
  const removeList = (i: number) => setDraft((d) => ({ ...d, lists: d.lists.length > 1 ? d.lists.filter((_, j) => j !== i) : [emptyList()] }));
  const fieldInput = (f: UsageField) => (
    <Field key={f} label={`${FIELD_LABEL[f]}${REQUIRED_FIELDS.includes(f) ? " (required)" : ""}`}>
      <Input className={u.mono} value={draft.sources[f]} placeholder="not reported" spellCheck={false} onChange={(e) => setSource(f, e.target.value)} />
    </Field>
  );
  return (
    <section className={u.panel} aria-labelledby="usage-map-title">
      <h3 id="usage-map-title" className={u.panelTitle}>
        1 · Where the counts are — version {props.version}
      </h3>
      <p className={u.lead}>
        Each count is a JSON pointer into the provider's response (RFC 6901, for example <code>/usage/prompt_tokens</code>), pointers joined by{" "}
        <code>+</code> to add them, or a sum over a list. No code or expressions.
      </p>
      <form
        className={`${u.panel} ${u.panelBare}`}
        onSubmit={(e) => {
          e.preventDefault();
          const out = buildMapping(draft);
          if ("errors" in out) return setProblems(out.errors);
          setProblems([]);
          void save
            .run(() => api.post<UsageExtractorVersion>(`/v1/agents/${props.agentId}/usage-extractor/versions`, { mapping: out.mapping }), `Version ${props.version} saved: test it before activating`)
            .then((row) => {
              if (row?.id) props.onSaved(row.id);
            });
        }}
      >
        {MAIN_FIELDS.map(fieldInput)}
        <details className={u.more}>
          <summary>Image out, audio out, and sums over a list</summary>
          <div className={`${u.panel} ${u.panelBare}`}>
            {MORE_FIELDS.map(fieldInput)}
            <Field label="The totals include">
              <Select value={draft.totalsInclude} onChange={(e) => setDraft((d) => ({ ...d, totalsInclude: e.target.value === "text_only" ? "text_only" : "all" }))}>
                <option value="all">Image and audio (text is the remainder)</option>
                <option value="text_only">Text only (image and audio are added)</option>
              </Select>
            </Field>
            <p className={u.lead}>For usage reported as a list by modality: pick the list, the value pointer, and which entries count. Each count can have its own sum.</p>
            {draft.lists.map((l, i) => {
              const legend = draft.lists.length > 1 ? `Sum over a list ${i + 1}` : "Sum over a list";
              return (
                <Fieldset key={i} legend={legend}>
                  <div className={u.countGrid}>
                    <Field label="Count it gives">
                      <Select value={l.field} onChange={(e) => setList(i, { field: e.target.value as UsageField | "" })}>
                        <option value="">— none —</option>
                        {USAGE_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABEL[f]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="List pointer">
                      <Input className={u.mono} value={l.array} spellCheck={false} onChange={(e) => setList(i, { array: e.target.value })} />
                    </Field>
                    <Field label="Value pointer (in each entry)">
                      <Input className={u.mono} value={l.value} spellCheck={false} onChange={(e) => setList(i, { value: e.target.value })} />
                    </Field>
                    <Field label="Only entries where (pointer)">
                      <Input className={u.mono} value={l.wherePointer} spellCheck={false} onChange={(e) => setList(i, { wherePointer: e.target.value })} />
                    </Field>
                    <Field label="equals one of (comma-separated)">
                      <Input value={l.equals} spellCheck={false} onChange={(e) => setList(i, { equals: e.target.value })} />
                    </Field>
                  </div>
                  {draft.lists.length > 1 && (
                    <Button size="sm" variant="ghost" onClick={() => removeList(i)} aria-label={`Remove ${legend.toLowerCase()}`}>
                      Remove this sum
                    </Button>
                  )}
                </Fieldset>
              );
            })}
            <div>
              <Button size="sm" onClick={addList}>
                Add a sum over a list
              </Button>
            </div>
          </div>
        </details>
        {problems.length > 0 && (
          <div className={`${u.notice} ${u.danger}`} role="alert">
            <strong>Cannot save yet:</strong>
            <ul>
              {problems.map((p, i) => (
                <li key={`${i}-${p}`}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <Refusal outcome={save.outcome} lead="Cannot save yet:" />
        <div className={u.footRow}>
          <Button type="submit" variant="primary" busy={save.busy}>
            Save version {props.version}
          </Button>
          <Button onClick={props.onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

function TestPanel(props: { agentId: string; version: UsageExtractorVersion; isActive: boolean; replaces: number | null; onClose: () => void }) {
  const v = props.version;
  const fields = mappedFields(v.mapping);
  const asked = USAGE_FIELDS.filter((f) => fields.includes(f) || REQUIRED_FIELDS.includes(f));
  const [sample, setSample] = useState("");
  const [expected, setExpected] = useState<Partial<Record<UsageField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<Partial<Record<UsageField, number>> | null>(null);
  const [result, setResult] = useState<UsageExtractorTestResult | null>(null);
  const test = useApiAction();
  const act = useApiAction();
  const rows = result && sent ? testRows(fields, sent, result.extracted) : [];
  return (
    <section className={u.panel} aria-labelledby="usage-test-title">
      <h3 id="usage-test-title" className={u.panelTitle}>
        2 · Test version {v.version} against a sample response
      </h3>
      <p className={u.lead}>
        Paste one real response and the counts it should give. The test passes only on exact counts. Only a fingerprint of the sample is kept, never
        the sample.
      </p>
      <form
        className={`${u.panel} ${u.panelBare}`}
        onSubmit={(e) => {
          e.preventDefault();
          const out = buildTestBody(sample, expected, fields);
          if ("error" in out) return setProblem(out.error);
          setProblem(null);
          setResult(null);
          void test
            .run(
              () => api.post<UsageExtractorTestResult>(`/v1/agents/${props.agentId}/usage-extractor/versions/${v.id}/test`, out.body),
              `Version ${v.version} tested`,
            )
            .then((r) => {
              if (r) {
                setSent(out.body.expected);
                setResult(r);
              }
            });
        }}
      >
        <Field label={`Sample response (JSON, up to ${SAMPLE_MAX_LABEL})`}>
          <Textarea className={u.mono} rows={8} value={sample} spellCheck={false} onChange={(e) => setSample(e.target.value)} />
        </Field>
        <Fieldset legend="Counts it should give">
          <div className={u.countGrid}>
            {asked.map((f) => (
              <Field key={f} label={FIELD_LABEL[f]}>
                <Input inputMode="numeric" value={expected[f] ?? ""} onChange={(e) => setExpected((x) => ({ ...x, [f]: e.target.value }))} />
              </Field>
            ))}
          </div>
        </Fieldset>
        {problem && (
          <div className={`${u.notice} ${u.danger}`} role="alert">
            {problem}
          </div>
        )}
        <Refusal outcome={test.outcome} lead="Not tested." />
        <div className={u.footRow}>
          <Button type="submit" busy={test.busy}>
            Run test
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </form>
      {result && (
        <div className={u.result} role="status">
          <p className={`${u.resultHead} ${result.passed ? u.resultPass : u.resultFail}`}>
            {result.passed
              ? props.isActive
                ? `✓ Passed — version ${v.version} is the active version`
                : `✓ Passed — version ${v.version} can be activated`
              : `✕ Failed — ${failureText(result.failure) || "the counts differ"}`}
          </p>
          <Table
            rows={rows}
            rowKey={(r) => r.field}
            columns={[
              { key: "count", header: "Count", render: (r) => r.label },
              { key: "expected", header: "Expected", render: (r) => fmtCount(r.expected) },
              { key: "read", header: "Read", render: (r) => (r.read === null ? "not read" : fmtCount(r.read)) },
              { key: "result", header: "Result", render: (r) => (r.match ? <Badge tone="ok">✓ match</Badge> : <Badge tone="danger">✕ differs</Badge>) },
            ]}
          />
        </div>
      )}
      {result?.passed && !props.isActive && (
        <div className={u.footRow}>
          <Button
            variant="primary"
            busy={act.busy}
            onClick={() =>
              void act.run(
                () => withStepUp((h) => stepUpApi.post(`/v1/agents/${props.agentId}/usage-extractor/versions/${v.id}/activate`, {}, h)),
                `Version ${v.version} activated`,
              )
            }
          >
            Activate version {v.version}…
          </Button>
          <span className={u.lead}>Asks for a step-up.{props.replaces !== null ? ` Replaces version ${props.replaces} for this agent.` : ""}</span>
        </div>
      )}
      <Refusal outcome={act.outcome} version={v.version} />
    </section>
  );
}
