/**
 * ADR-0339 — one agent's risk and identity.
 *
 *  - The live score (computed now from current records), its reach and OWASP exposure, and the fixes ranked by how much
 *    each lowers it. Each fix links to where the change is made; this page changes nothing about the agent.
 *  - Every factor with its points, evidence and OWASP ids.
 *  - Dangerous combinations: for each one held, its legs (what makes each true) and every way to break it, ranked.
 *    These options are read-only here: whether one may be applied automatically is still an owner decision.
 *  - The stored history, newest first, with what triggered each score; "Recompute" scores this agent now (audited).
 *  - Who wrote it, who owns it and who runs it, and its non-human identities. Linking one is staged by one admin and
 *    confirmed or rejected by a different admin, who is asked to confirm it is them; a link confers nothing.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, RecordError, RowActions, Select, SkeletonBlock, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import { withRefusalCopy } from "./refusalCopy";
import {
  AGENT_NHI_KINDS,
  AGENT_NHI_PROVIDERS,
  AUTHOR_LABEL,
  BAND_LABEL,
  BAND_TONE,
  EMPTY_LINK,
  FLAG_LABEL,
  FLAG_TONE,
  historyUrl,
  isSubjectKind,
  LINK_REFUSALS,
  LINK_STATUS_LABEL,
  LINK_STATUS_TONE,
  linkBody,
  linkProblems,
  NHI_ID_HINT,
  NHI_KIND_LABEL,
  NHI_PROVIDER_LABEL,
  sharedText,
  sweepSentence,
  TRIGGER_LABEL,
  type Assessment,
  type Factor,
  type HistoryPage,
  type IdentityView,
  type LinkDraft,
  type NhiKind,
  type NhiLink,
  type NhiProvider,
  type RankedFix,
  type SubjectKind,
  type SweepResult,
  type ToxicCombination,
} from "./agentRiskModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const back = <Link to="/admin/agent-risk">Back to agent risk</Link>;

export default function AgentRiskDetailPage() {
  const { kind = "", id = "" } = useParams();
  if (!isSubjectKind(kind)) return <RecordError noun="agent" error={{ status: 404 }} action={back} />;
  return <Detail kind={kind} id={id} />;
}

function Detail({ kind, id }: { kind: SubjectKind; id: string }) {
  const key = ["admin", "agent-risk", kind, id] as const;
  const risk = useQuery({ queryKey: [...key, "live"], queryFn: () => api.get<Assessment>(`/v1/agent-risk/${kind}/${id}`) });
  const act = useAction();
  if (risk.error) return <RecordError noun="agent" error={risk.error} onRetry={() => void risk.refetch()} action={back} />;
  const r = risk.data;
  const recompute = () =>
    void act.run(async () => sweepSentence(await api.post<SweepResult>("/v1/agent-risk/recompute", { kind, subjectId: id })));
  const held = r?.toxicCombinations.filter((c) => c.present) ?? [];

  return (
    <>
      <PageHeader
        title={r?.subject.name ?? "Agent risk"}
        crumbs={["Agent risk"]}
        sub={kind === "agent" ? "A registry agent: its risk, its fixes and who answers for it." : "A builder agent: its risk, its fixes and who answers for it."}
        info={r ? <p>{r.disclaimer}</p> : undefined}
        actions={
          <Button variant="primary" aria-disabled={act.busy || undefined} onClick={() => !act.busy && recompute()}>
            {act.busy ? "Recomputing…" : "Recompute"}
          </Button>
        }
      />
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />
        {!r ? (
          <Card title="Score">
            <SkeletonBlock lines={4} />
          </Card>
        ) : (
          <>
            <Card title="Score" info={<p>{r.method}</p>} infoLabel="How the score is calculated">
              <div className={v.kpiStrip}>
                <div className={v.stat}>
                  <div className={v.statValue}>
                    {r.score}
                    <span className={v.faint}> / 100</span>
                  </div>
                  <div className={v.statLabel}>
                    <Badge tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Badge>
                  </div>
                </div>
                <div className={v.stat}>
                  <div className={v.statValue}>×{r.reach.multiplier}</div>
                  <div className={v.statLabel}>Reach: {r.reach.label}</div>
                </div>
                <div className={v.stat}>
                  <div className={v.statValue}>{held.length}</div>
                  <div className={v.statLabel}>{held.length === 1 ? "Dangerous combination held" : "Dangerous combinations held"}</div>
                </div>
              </div>
              <p className={v.hint}>{r.reach.detail}</p>
              <p className={v.faint}>
                {r.latestAssessment ? `Last stored ${ago(r.latestAssessment.computedAt)} at ${r.latestAssessment.score}.` : "Not stored yet."}
                {r.recomputePending ? " A change is waiting to be scored." : ""}
                {r.owaspExposure.length ? ` OWASP exposure: ${r.owaspExposure.join(", ")}.` : ""}
              </p>
            </Card>
            <FixesCard fixes={r.fixes} />
            {r.toxicCombinations.map((c) => (
              <CombinationCard key={c.id} c={c} />
            ))}
            <FactorsCard factors={r.factors} />
          </>
        )}
        <HistoryCard kind={kind} id={id} />
        <IdentityCards kind={kind} id={id} />
      </div>
    </>
  );
}

function FixesCard({ fixes }: { fixes: RankedFix[] }) {
  return (
    <Card title="Fixes, most effective first" count={fixes.length}>
      <Table<RankedFix>
        rows={fixes}
        rowKey={(f) => `${f.rank}-${f.source}`}
        empty={<EmptyState title="Nothing to fix" body="No factor adds to this agent's score." />}
        columns={[
          { key: "rank", header: "#", render: (f) => f.rank },
          { key: "title", header: "Fix", render: (f) => f.title },
          { key: "points", header: "Lowers the score by", render: (f) => plural(f.points, "point") },
          { key: "where", header: "Where", render: (f) => <Link to={f.link.to}>{f.link.label}</Link> },
        ]}
      />
    </Card>
  );
}

function CombinationCard({ c }: { c: ToxicCombination }) {
  if (!c.present) {
    return (
      <Card title={c.title}>
        <p>
          <Badge tone="ok">Not held</Badge> <span className={v.faint}>{c.evidence}</span>
        </p>
      </Card>
    );
  }
  return (
    <Card title={c.title} info={<p>OWASP {c.owasp.join(", ")}. Adds {plural(c.points, "point")} to the score.</p>} infoLabel={`About ${c.title}`}>
      <p>
        <Badge tone="danger">Held</Badge> {c.evidence}
      </p>
      {c.legs?.map((leg) => (
        <div key={leg.id}>
          <div className={v.sectionTitle}>{leg.label}</div>
          {leg.members.length ? (
            <ul>
              {leg.members.map((m) => (
                <li key={`${m.kind}:${m.id}`}>
                  {m.name} <span className={v.faint}>— {m.why}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={v.faint}>Nothing this agent holds makes this true.</p>
          )}
        </div>
      ))}
      {c.fixOptions?.length ? (
        <>
          <div className={v.sectionTitle}>Ways to break it, ranked</div>
          <p className={v.hint}>Changing any one leg breaks the combination. Nothing is changed from here; make the change where the tool or connector is managed.</p>
          <ol>
            {c.fixOptions.map((o) => (
              <li key={o.rank}>
                {o.title}
                {sharedText(o) ? <span className={v.faint}> ({sharedText(o)})</span> : null}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p>
          {c.fix.title}. <Link to={c.fix.link.to}>{c.fix.link.label}</Link>
        </p>
      )}
    </Card>
  );
}

function FactorsCard({ factors }: { factors: Factor[] }) {
  return (
    <Card title="Every factor" count={factors.length}>
      <Table<Factor>
        rows={factors}
        rowKey={(f) => f.id}
        columns={[
          {
            key: "title",
            header: "Factor",
            render: (f) => (
              <>
                <div>{f.title}</div>
                <div className={v.faint}>OWASP {f.owasp.join(", ")}</div>
              </>
            ),
          },
          {
            key: "points",
            header: "Points",
            render: (f) => (
              <>
                <Badge tone={f.present ? "warn" : "ok"}>{f.present ? "Adds risk" : "Clear"}</Badge> <span className={v.num}>{f.points}</span>
                <span className={v.faint}> of {f.max}</span>
              </>
            ),
          },
          { key: "evidence", header: "Why", render: (f) => f.evidence },
        ]}
      />
    </Card>
  );
}

function HistoryCard({ kind, id }: { kind: SubjectKind; id: string }) {
  const list = useInfiniteQuery({
    queryKey: ["admin", "agent-risk", kind, id, "history"],
    queryFn: ({ pageParam }) => api.get<HistoryPage>(historyUrl(kind, id, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items);
  return (
    <Card title="History">
      <Table<NonNullable<typeof rows>[number]>
        rows={rows}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(h) => h.id}
        empty={<EmptyState title="No stored score yet" body="Recompute to store the first one." />}
        columns={[
          { key: "at", header: "Scored", render: (h) => fmtAt(h.computedAt) },
          { key: "score", header: "Risk", render: (h) => <><Badge tone={BAND_TONE[h.band]}>{BAND_LABEL[h.band]}</Badge> <span className={v.num}>{h.score}</span></> },
          { key: "why", header: "Because", render: (h) => h.triggers.map((t) => TRIGGER_LABEL[t] ?? t).join(", ") },
        ]}
      />
      {list.hasNextPage ? (
        <div className={v.row}>
          <Button aria-disabled={list.isFetchingNextPage || undefined} onClick={() => !list.isFetchingNextPage && void list.fetchNextPage()}>
            {list.isFetchingNextPage ? "Loading…" : "Load older"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function IdentityCards({ kind, id }: { kind: SubjectKind; id: string }) {
  const view = useQuery({ queryKey: ["admin", "agent-identity", kind, id], queryFn: () => api.get<IdentityView>(`/v1/agent-identity/${kind}/${id}`) });
  const act = useAction();
  const [draft, setDraft] = useState<LinkDraft>(EMPTY_LINK);
  const [tried, setTried] = useState(false);
  const [deciding, setDeciding] = useState<{ link: NhiLink; decision: "confirmed" | "rejected" } | null>(null);
  const problems = linkProblems(draft);
  const shown = tried ? problems : {};
  const refetch = () => void view.refetch();

  const stage = () => {
    setTried(true);
    if (problems.externalId || problems.note || act.busy) return;
    void act
      .run(() => withRefusalCopy(() => api.post(`/v1/agent-identity/${kind}/${id}/links`, linkBody(draft)), LINK_REFUSALS), "Link staged. A different admin now confirms or rejects it.")
      .then((done) => {
        if (!done) return;
        setDraft(EMPTY_LINK);
        setTried(false);
        refetch();
      });
  };
  const decide = () => {
    const d = deciding;
    setDeciding(null);
    if (!d) return;
    void act
      .run(
        () => withRefusalCopy(() => withStepUp((h) => stepUpApi.post(`/v1/agent-identity/links/${d.link.id}/decision`, { decision: d.decision }, h)), LINK_REFUSALS),
        d.decision === "confirmed" ? "Link confirmed." : "Link rejected.",
      )
      .then((done) => done && refetch());
  };

  if (view.error) return <RecordError noun="agent identity" error={view.error} onRetry={refetch} />;
  const iv = view.data;
  return (
    <>
      <Card title="Who wrote, owns and runs it">
        {!iv ? (
          <SkeletonBlock lines={4} />
        ) : (
          <dl className={a.formRow}>
            <div>
              <dt className={v.faint}>Written by</dt>
              <dd>
                {iv.author.displayName ?? iv.author.vendorCreatorPseudonym ?? "—"}
                <div className={v.faint}>{AUTHOR_LABEL[iv.author.source]}</div>
              </dd>
            </div>
            <div>
              <dt className={v.faint}>Owner</dt>
              <dd>
                <Badge tone={FLAG_TONE[iv.ownership.flag]}>{FLAG_LABEL[iv.ownership.flag]}</Badge>
                <div className={v.faint}>last active {ago(iv.ownership.ownerLastActiveAt)}</div>
              </dd>
            </div>
            <div>
              <dt className={v.faint}>Runs as</dt>
              <dd>
                {iv.runner.workloadIdentity ? <code>{iv.runner.workloadIdentity.identifier}</code> : "No workload identity"}
                {iv.runner.unattendedRunsAs ? <div className={v.faint}>Unattended runs act as {iv.runner.unattendedRunsAs}; it uses {iv.runner.connections}.</div> : null}
              </dd>
            </div>
            <div>
              <dt className={v.faint}>Run by, last {iv.runner.windowDays} days</dt>
              <dd>
                {iv.runner.invokers.length
                  ? iv.runner.invokers.map((p) => `${p.displayName ?? "A former user"} (${plural(p.calls, "call")})`).join(", ")
                  : "Nobody"}
                {iv.runner.moreInvokers ? <div className={v.faint}>and others</div> : null}
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title="Non-human identities" count={iv?.nonHumanIdentities.length}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <Table<NhiLink>
          rows={iv?.nonHumanIdentities}
          loading={view.isLoading}
          rowKey={(l) => l.id}
          empty={<EmptyState title="No identity linked" body="Link the cloud service account, vendor agent identity or OAuth client this agent uses, below." />}
          columns={[
            {
              key: "id",
              header: "Identity",
              render: (l) => (
                <>
                  <div>{NHI_KIND_LABEL[l.kind]} · {NHI_PROVIDER_LABEL[l.provider]}</div>
                  <code className={v.faint}>{l.externalId}</code>
                </>
              ),
            },
            {
              key: "status",
              header: "State",
              render: (l) => (
                <>
                  <Badge tone={LINK_STATUS_TONE[l.status]}>{LINK_STATUS_LABEL[l.status]}</Badge>
                  <div className={v.faint}>{l.decidedAt ? `decided ${ago(l.decidedAt)}` : `staged ${ago(l.stagedAt)}`}</div>
                </>
              ),
            },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              render: (l) =>
                l.status === "staged" ? (
                  <RowActions
                    primary={
                      <Button size="sm" aria-label={`Confirm ${l.externalId}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setDeciding({ link: l, decision: "confirmed" })}>
                        Confirm
                      </Button>
                    }
                    secondary={
                      <Button size="sm" variant="ghost" aria-label={`Reject ${l.externalId}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setDeciding({ link: l, decision: "rejected" })}>
                        Reject
                      </Button>
                    }
                  />
                ) : (
                  <RowActions primary={null} />
                ),
            },
          ]}
        />
        <form
          className={v.stack}
          aria-label="Link an identity"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            stage();
          }}
        >
          <div className={a.formRow}>
            <Field label="Kind">
              <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as NhiKind })}>
                {AGENT_NHI_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {NHI_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Provider">
              <Select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as NhiProvider })}>
                {AGENT_NHI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {NHI_PROVIDER_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Identifier" grow error={shown.externalId} help={NHI_ID_HINT[draft.provider]}>
              <Input value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} />
            </Field>
          </div>
          <Field label="Note (optional)" error={shown.note}>
            <Input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
          <div className={v.row}>
            <Button type="submit" aria-disabled={act.busy || undefined}>
              Stage link
            </Button>
            <span className={v.faint}>A staged link grants nothing. A different admin confirms or rejects it.</span>
          </div>
        </form>
      </Card>

      <ConfirmModal
        open={deciding !== null}
        danger={deciding?.decision === "rejected"}
        title={deciding ? `${deciding.decision === "confirmed" ? "Confirm" : "Reject"} ${deciding.link.externalId}?` : "Decide this link?"}
        body={
          <p>
            {deciding?.decision === "confirmed"
              ? "The agent is then recorded as running under this identity. The link grants nothing by itself."
              : "The link is closed and kept for the record. Stage it again if this was a mistake."}{" "}
            This is recorded in the audit trail, and you will be asked to confirm it is you.
          </p>
        }
        confirmLabel={deciding?.decision === "confirmed" ? "Confirm link" : "Reject link"}
        onConfirm={decide}
        onCancel={() => setDeciding(null)}
      />
    </>
  );
}
