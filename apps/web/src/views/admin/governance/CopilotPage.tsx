/**
 * AI governance copilot (ADR-0056).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **It answers with YOUR entitlements, not the platform's.** Every answer
 *    prints the scope it was narrowed to and the caveat that a zero means "none
 *    in your scope", never "none anywhere".
 *  - **It reads; it does not act.** The tool surface is listed with what each
 *    tool CANNOT do, and the mutating-tool list is rendered — empty, because it
 *    is empty.
 *  - **The answer is grounded in counts.** The retrieved evidence is shown
 *    beside the prose, so an answer is traceable to the records that produced
 *    it rather than taken on trust.
 *  - **A refusal is rendered as a refusal.** When the retrieval returns no
 *    governance object at all, the page shows a REFUSED badge and the refusal
 *    text — it does not dress an empty read up as an answer. Every answer
 *    lists the concrete object ids it is grounded in.
 *  - **Verification is per-answer, not a build-wide claim.** A narration that
 *    passed the grounding cross-check is badged "grounded + narrated
 *    (cross-checked)"; one that was discarded says so with the reason.
 *  - **An approved proposal can be applied, and only an approved one.** The
 *    proposals table renders each proposal's approval state, an Apply button
 *    that exists only where applying is possible, and the refusal reason
 *    verbatim where it is not.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Table } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface ToolSpec {
  id: string;
  ledger: string;
  whatItReads: string;
  whatItCannotDo: string;
}
interface ToolsResponse {
  tools: ToolSpec[];
  mutatingTools: string[];
  note: string;
  scopeCaveat: string;
  decisionSupport: string;
}
interface AskResponse {
  plan: { tool: string; timeframe: string; matched: string[]; fallback: boolean };
  answer: {
    text: string;
    scopeCaveat: string;
    notice: string;
    generation: string;
    groundedRefusal: boolean;
    citedObjectIds: string[];
    modelNarrationVerified: boolean;
  };
  evidence: {
    rowsExamined: number;
    counts: Array<{ key: string; label: string; value: number }>;
    leads: Array<{ kind: string; subject: string; detail: string; evidenceCount: number }>;
    citableObjects: Array<{ kind: string; id: string; label: string }>;
  };
  scope: { projectIds: string[] | null; statement: string };
  narrationDiscarded?: string;
  note: string;
}
interface ProposalRow {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  approvalId: string | null;
  appliedAt: string | null;
  appliedResult: Record<string, unknown> | null;
}
interface ApprovalRow {
  id: string;
  status: string;
}
interface QueryRow {
  id: string;
  question: string;
  generation: string;
  guardrailAction: string | null;
  createdAt: string;
}

export default function CopilotPage() {
  const tools = useQuery({ queryKey: ["copilot", "tools"], queryFn: () => api.get<ToolsResponse>("/v1/copilot/tools") });
  const history = useQuery({
    queryKey: ["copilot", "queries"],
    queryFn: () => api.get<{ queries: QueryRow[] }>("/v1/copilot/queries"),
  });
  const act = useAction();

  const proposals = useQuery({
    queryKey: ["copilot", "proposals"],
    queryFn: () => api.get<{ proposals: ProposalRow[] }>("/v1/copilot/proposals"),
  });
  // the approval STATE each proposal rests on, read from the ONE queue — the
  // page never infers consent, it renders the queue's own answer
  const approvalList = useQuery({
    queryKey: ["copilot", "approvals"],
    queryFn: () => api.get<{ approvals: ApprovalRow[] }>("/v1/approvals"),
  });

  const [question, setQuestion] = useState("Who accessed PII last quarter?");
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [applied, setApplied] = useState<Record<string, string>>({});

  const statusOf = (p: ProposalRow): string => {
    if (!p.approvalId) return "no approval";
    return approvalList.data?.approvals.find((a) => a.id === p.approvalId)?.status ?? "unknown";
  };

  const applyProposal = (p: ProposalRow) =>
    void act.run(async () => {
      const res = await api.post<{ applied: Record<string, unknown> }>(
        `/v1/copilot/proposals/${p.id}/apply`,
        {},
      );
      setApplied((prev) => ({ ...prev, [p.id]: JSON.stringify(res.applied) }));
      await proposals.refetch();
    }, "Applied through the same public endpoint an admin would use, under your own identity");

  const ask = async () => {
    const ok = await act.run(async () => {
      const res = await api.post<AskResponse>("/v1/copilot/ask", { question });
      setAnswer(res);
    }, "Answered from the ledgers, within your own scope");
    if (ok) void history.refetch();
  };

  return (
    <>
      <PageHeader
        title="Governance copilot"
        sub="Ask the audit trail in plain language — scoped to what you may read, and unable to change anything."
      />

      <Card title="What it is, and what it cannot be">
        <p className={v.faint}>
          The copilot is a governed tenant of this platform, not a privileged component. It reads only
          what you may read, its model calls are metered and audited like any other agent's, and it has
          no mutating tools: its only route to a change is a proposal that opens an ordinary approval.
        </p>
        <p className={v.dim}>{tools.data?.scopeCaveat}</p>
        <p className={v.dim}>{tools.data?.decisionSupport}</p>
      </Card>

      <Card title="Ask">
        <Field label="Question" grow>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
        <div className={v.row}>
          <Button variant="primary" disabled={act.busy} onClick={() => void ask()}>
            Ask
          </Button>
        </div>
      </Card>

      {answer ? (
        <>
          <Card title="Answer">
            <p className={v.dim}>{answer.scope.statement}</p>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{answer.answer.text}</pre>
            <div className={v.row}>
              <Badge tone={answer.answer.generation === "model" ? "info" : "neutral"}>
                {answer.answer.generation === "model"
                  ? answer.answer.modelNarrationVerified
                    ? "grounded + narrated (cross-checked)"
                    : "grounded + narrated"
                  : "grounded (no model called)"}
              </Badge>
              {answer.answer.groundedRefusal ? (
                <Badge tone="danger">REFUSED — nothing retrieved</Badge>
              ) : null}
              {answer.plan.fallback ? <Badge tone="warn">question not matched</Badge> : null}
              {answer.narrationDiscarded ? <Badge tone="danger">narration discarded</Badge> : null}
            </div>
            {answer.narrationDiscarded ? (
              <p className={v.errLine}>
                The model narration was DISCARDED and the grounded answer stands: {answer.narrationDiscarded}
              </p>
            ) : null}
            <p className={v.faint}>{answer.answer.scopeCaveat}</p>
            <p className={v.faint}>{answer.note}</p>
          </Card>

          <Card title="Evidence behind the answer">
            <div className={a.statRow}>
              <Stat value={answer.evidence.rowsExamined} label="Records examined (in your scope)" />
              <Stat value={answer.plan.tool} label="Read tool used" />
              <Stat value={answer.plan.timeframe} label="Timeframe" />
            </div>
            <Table<{ key: string; label: string; value: number }>
              rows={answer.evidence.counts}
              rowKey={(c) => c.key}
              columns={[
                { key: "k", header: "Count", render: (c) => <code>{c.key}</code> },
                { key: "l", header: "What it is", render: (c) => <span className={v.dim}>{c.label}</span> },
                { key: "v", header: "Value", render: (c) => c.value },
              ]}
            />
            {answer.evidence.citableObjects.length ? (
              <>
                <p className={v.faint}>
                  Grounded in these governance objects — the only records this answer may rest on:
                </p>
                <Table<AskResponse["evidence"]["citableObjects"][number]>
                  rows={answer.evidence.citableObjects}
                  rowKey={(o) => o.id}
                  columns={[
                    { key: "kind", header: "Ledger", render: (o) => <code>{o.kind}</code> },
                    { key: "id", header: "Object id", render: (o) => <code>{o.id}</code> },
                    { key: "label", header: "What it is", render: (o) => <span className={v.dim}>{o.label}</span> },
                  ]}
                />
              </>
            ) : (
              <p className={v.faint}>
                No governance object was retrieved in your scope, so there is nothing for an answer to cite. That is
                why the answer above is a refusal rather than a summary.
              </p>
            )}
            {answer.evidence.leads.length ? (
              <>
                <p className={v.faint}>
                  Leads for a human to verify — not findings, and never a verdict.
                </p>
                <Table<AskResponse["evidence"]["leads"][number]>
                  rows={answer.evidence.leads}
                  rowKey={(l) => `${l.kind}:${l.subject}`}
                  columns={[
                    { key: "kind", header: "Kind", render: (l) => <code>{l.kind}</code> },
                    { key: "subject", header: "Subject", render: (l) => l.subject },
                    { key: "detail", header: "Why", render: (l) => <span className={v.dim}>{l.detail}</span> },
                    { key: "n", header: "Records", render: (l) => l.evidenceCount },
                  ]}
                />
              </>
            ) : null}
          </Card>
        </>
      ) : null}

      <Card title="Everything it can do">
        <QueryGate loading={tools.isLoading} error={tools.error} onRetry={() => void tools.refetch()}>
          <Table<ToolSpec>
            rows={tools.data?.tools ?? []}
            rowKey={(t) => t.id}
            columns={[
              { key: "id", header: "Tool", render: (t) => <code>{t.id}</code> },
              { key: "ledger", header: "Ledger", render: (t) => <code>{t.ledger}</code> },
              { key: "reads", header: "What it reads", render: (t) => <span className={v.dim}>{t.whatItReads}</span> },
              {
                key: "cannot",
                header: "What it cannot do",
                render: (t) => <span className={v.dim}>{t.whatItCannotDo}</span>,
              },
            ]}
          />
          <p className={v.faint}>
            Mutating tools: {(tools.data?.mutatingTools ?? []).length === 0 ? "none" : tools.data?.mutatingTools.join(", ")}.{" "}
            {tools.data?.note}
          </p>
        </QueryGate>
      </Card>

      <Card title="Proposals — recorded, approved by a human, then applied">
        <p className={v.faint}>
          A proposal changes nothing by existing. Applying one is gated on the linked approval in the ordinary
          Approvals Queue, and executes through the same public endpoint an admin would use by hand — audited under
          the applying admin's identity, never the copilot's. A kind with no such endpoint refuses by name rather
          than writing the change directly.
        </p>
        <QueryGate loading={proposals.isLoading} error={proposals.error} onRetry={() => void proposals.refetch()}>
          {(proposals.data?.proposals ?? []).length === 0 ? (
            <EmptyState title="No proposals yet" body="Ask a question, then propose a change from its evidence." />
          ) : (
            <Table<ProposalRow>
              rows={proposals.data?.proposals ?? []}
              rowKey={(p) => p.id}
              columns={[
                { key: "t", header: "Proposal", render: (p) => p.title },
                { key: "k", header: "Kind", render: (p) => <code>{p.kind}</code> },
                {
                  key: "s",
                  header: "Consent",
                  render: (p) => {
                    const st = statusOf(p);
                    return (
                      <Badge tone={st === "approved" ? "ok" : st === "denied" ? "danger" : "warn"}>{st}</Badge>
                    );
                  },
                },
                {
                  key: "a",
                  header: "Applied",
                  render: (p) =>
                    p.appliedAt ? (
                      <>
                        <Badge tone="ok">applied</Badge>{" "}
                        <span className={v.faint}>{ago(p.appliedAt)}</span>
                      </>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                },
                {
                  key: "do",
                  header: "",
                  render: (p) =>
                    p.appliedAt ? (
                      <span className={v.faint}>{applied[p.id] ?? "applied once; applying is not repeatable"}</span>
                    ) : statusOf(p) === "approved" ? (
                      <Button disabled={act.busy} onClick={() => applyProposal(p)}>
                        Apply
                      </Button>
                    ) : (
                      <span className={v.faint}>
                        cannot apply: the linked approval is {statusOf(p)}, and consent is the gate
                      </span>
                    ),
                },
              ]}
            />
          )}
        </QueryGate>
      </Card>

      <Card title="Your recent questions">
        <QueryGate loading={history.isLoading} error={history.error} onRetry={() => void history.refetch()}>
          {(history.data?.queries ?? []).length === 0 ? (
            <EmptyState title="Nothing asked yet" body="Ask a governance question above." />
          ) : (
            <Table<QueryRow>
              rows={history.data?.queries ?? []}
              rowKey={(q) => q.id}
              columns={[
                { key: "q", header: "Question", render: (q) => q.question },
                { key: "g", header: "Generation", render: (q) => <Badge tone="neutral">{q.generation}</Badge> },
                {
                  key: "gr",
                  header: "Guardrail",
                  render: (q) =>
                    q.guardrailAction ? <Badge tone="warn">{q.guardrailAction}</Badge> : <span className={v.faint}>—</span>,
                },
                { key: "at", header: "Asked", render: (q) => ago(q.createdAt) },
              ]}
            />
          )}
        </QueryGate>
      </Card>
    </>
  );
}
