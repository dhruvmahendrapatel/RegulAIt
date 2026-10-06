/**
 * ADR-0182 (ADR-0175 batch D4) A11 — THE DECISION RECORDS (which versions
 * produced each decision), as a tab of the use-case record. OWNER: A11 (D4).
 *
 * Every terminal sign-off decision (approved, rejected, returned for
 * information) is written with the versions that produced it, in the
 * decision's own transaction: the review-policy version, the required-tests
 * policy, the intake template and its definition, the screening rule set, the
 * suggestion rules and the answers. Visible to the use case's owner and to
 * admins (the gateway refuses anyone else).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Card, EmptyState, Table, type Tone } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import { shortDate } from "./useCaseLifecycle";

interface DecisionRecord {
  id: string;
  outcome: "approved" | "rejected" | "needs_info";
  decidedAt: string;
  decidedByName: string | null;
  approvalId: string | null;
  workflowInstanceId: string | null;
  reviewPolicyVersion: number | null;
  requiredTestsDigest: string | null;
  intakeTemplateId: string | null;
  intakeTemplateName: string | null;
  intakeDefinitionDigest: string | null;
  euAiActRulesetVersion: number | null;
  intakeAssistVersion: string | null;
  answersDigest: string | null;
}
interface RecordsResponse {
  records: DecisionRecord[];
  current: { euAiActRulesetVersion: number; intakeAssistVersion: string };
}

const OUTCOME: Record<DecisionRecord["outcome"], { label: string; tone: Tone }> = {
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
  needs_info: { label: "Returned for information", tone: "warn" },
};

/** a digest shown short, with the whole value on hover and for copying */
function Digest(props: { value: string | null; label: string }) {
  if (!props.value) return <span className={v.faint}>none</span>;
  return (
    <code title={`${props.label}: ${props.value}`} aria-label={`${props.label} ${props.value}`}>
      {props.value.slice(0, 12)}
    </code>
  );
}

export function DecisionRecordTab(props: { useCaseId: string }) {
  const q = useQuery({
    queryKey: ["use-case", props.useCaseId, "decision-records"],
    queryFn: () => api.get<RecordsResponse>(`/v1/use-cases/${props.useCaseId}/decision-records`),
  });
  return (
    <Card title="Decision records">
      <p className={v.dim} style={{ marginTop: 0 }}>
        Each sign-off decision is recorded with the versions that produced it, so the decision can be reproduced later:
        the review policy, the required AI tests, the intake template, the screening rules and the suggestion rules.
        Digests identify a configuration exactly; the same digest means the same content.
      </p>
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data ? (
          <>
            <Table
              rows={q.data.records}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No decisions yet" body="A record is written when a sign-off approves, rejects or returns this use case." />}
              columns={[
                { key: "at", header: "Decided", render: (r) => shortDate(r.decidedAt), sort: (r) => r.decidedAt },
                { key: "outcome", header: "Decision", render: (r) => <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge> },
                { key: "by", header: "By", render: (r) => r.decidedByName ?? <span className={v.faint}>not recorded</span> },
                {
                  key: "policy",
                  header: "Review policy",
                  render: (r) => (r.reviewPolicyVersion !== null ? `Version ${r.reviewPolicyVersion}` : <span className={v.faint}>none set</span>),
                },
                { key: "tests", header: "Required tests", render: (r) => <Digest value={r.requiredTestsDigest} label="Required tests digest" /> },
                {
                  key: "template",
                  header: "Intake template",
                  render: (r) => (
                    <span>
                      {r.intakeTemplateName ?? <span className={v.faint}>unknown</span>}{" "}
                      <Digest value={r.intakeDefinitionDigest} label="Intake definition digest" />
                    </span>
                  ),
                },
                {
                  key: "rules",
                  header: "Screening and suggestion rules",
                  render: (r) =>
                    `${r.euAiActRulesetVersion !== null ? `screening v${r.euAiActRulesetVersion}` : "not screened"}, suggestions ${r.intakeAssistVersion ?? "unknown"}`,
                },
                { key: "answers", header: "Answers", render: (r) => <Digest value={r.answersDigest} label="Answers digest" /> },
              ]}
            />
            <p className={v.dim} style={{ marginBottom: 0 }}>
              Current rules: screening v{q.data.current.euAiActRulesetVersion}, suggestions {q.data.current.intakeAssistVersion}.
            </p>
          </>
        ) : null}
      </QueryGate>
    </Card>
  );
}
