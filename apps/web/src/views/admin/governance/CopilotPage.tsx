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
 *  - **Generation is unverified.** No model provider is connected in this
 *    build; the page says so rather than implying a narrated answer has been
 *    validated.
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
    modelNarrationVerified: boolean;
  };
  evidence: {
    rowsExamined: number;
    counts: Array<{ key: string; label: string; value: number }>;
    leads: Array<{ kind: string; subject: string; detail: string; evidenceCount: number }>;
  };
  scope: { projectIds: string[] | null; statement: string };
  narrationDiscarded?: string;
  note: string;
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

  const [question, setQuestion] = useState("Who accessed PII last quarter?");
  const [answer, setAnswer] = useState<AskResponse | null>(null);

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
                {answer.answer.generation === "model" ? "grounded + narrated" : "grounded (no model)"}
              </Badge>
              {answer.plan.fallback ? <Badge tone="warn">question not matched</Badge> : null}
              {answer.narrationDiscarded ? <Badge tone="danger">narration discarded</Badge> : null}
            </div>
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
