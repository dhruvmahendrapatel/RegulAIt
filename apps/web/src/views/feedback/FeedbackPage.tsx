/**
 * ADR-0182 (ADR-0175 batch D4) A13 — Feedback and appeals. OWNER: A13 (D4).
 *
 * The owner's queue: problem reports and appeals routed to the signed-in
 * person (an admin sees every item, including those routed to the admins
 * because the owner may not decide them), each with its response-time chip.
 * Opening an item is an audited read of what the person wrote. "Sent by me"
 * lists what the signed-in person submitted (status only). Admins also get the
 * feedback settings here (ADR-0182 main-session decision 1).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { PageHeader } from "../../shell/AppShell";
import { useSession } from "../../session/SessionContext";
import { Card, EmptyState, Field, Select, Tabs } from "../../ui/kit";
import { FeedbackDetail, FeedbackList, FeedbackSettings, type FeedbackItem } from "./feedbackKit";
import v from "../views.module.css";

type Scope = "queue" | "submitted";

export default function FeedbackPage() {
  const { auth } = useSession();
  const isAdmin = !!auth?.isAdmin;
  const [scope, setScope] = useState<Scope>("queue");
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["feedback", "list", scope, status],
    queryFn: () => api.get<{ items: FeedbackItem[] }>(`/v1/feedback?scope=${scope}&status=${status}`),
  });
  const items = q.data?.items;
  const overdue = (items ?? []).filter((i) => i.sla.chip === "breached").length;

  return (
    <>
      <PageHeader
        title="Feedback and appeals"
        sub="Problem reports and appeals about the use cases you own, with their response times."
        info={
          <p>
            People who use, or are affected by, an AI use case can report a problem or appeal a decision. Each item is
            routed to the use case&apos;s owner, who acknowledges and resolves it within the organisation&apos;s
            response times; an overdue item alerts its owner and the admins. An appeal is never decided by the person
            whose decision it contests. What people write is stored encrypted, opening it is recorded in the audit
            trail, and it is deleted after the retention period.
          </p>
        }
      />
      <div className={v.stack}>
        <Card>
          <div className={v.stack}>
            <div className={v.row}>
              <Tabs
                tabs={[
                  { id: "queue", label: isAdmin ? "All feedback" : "Routed to me" },
                  { id: "submitted", label: "Sent by me" },
                ]}
                active={scope}
                onChange={(id) => setScope(id as Scope)}
              />
              <span className={v.grow} />
              <Field label="Show">
                <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </Select>
              </Field>
            </div>
            {scope === "queue" && overdue > 0 && (
              <p role="status" className={v.hint}>
                {overdue === 1 ? "One item is" : `${overdue} items are`} past a response time.
              </p>
            )}
            <FeedbackList
              rows={items}
              loading={q.isLoading}
              error={q.error}
              onRetry={() => void q.refetch()}
              onOpen={scope === "queue" ? (r) => setOpenId(r.id) : undefined}
              empty={
                <EmptyState
                  title={scope === "queue" ? "Nothing routed to you" : "Nothing sent yet"}
                  body={
                    scope === "queue"
                      ? "Problem reports and appeals about the use cases you own appear here."
                      : "Reports and appeals you send from a use case's feedback form appear here, with their status."
                  }
                />
              }
            />
          </div>
        </Card>
        {isAdmin && <FeedbackSettings />}
      </div>
      <FeedbackDetail
        id={openId}
        onClose={() => {
          setOpenId(null);
          void q.refetch();
        }}
      />
    </>
  );
}
