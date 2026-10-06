/**
 * ADR-0182 (ADR-0175 batch D4) A13 — THE USE CASE'S FEEDBACK AND APPEALS (and its signed links), as a tab of the use-case record.
 * OWNER: A13 (D4).
 *
 *   - the use case's problem reports and appeals with their response-time
 *     chips (the server lists only what the viewer may see: the owner's own
 *     items, or every item for an admin); opening one is an audited read;
 *   - the in-app form's address, to hand to the people who use the system;
 *   - PUBLIC SIGNED LINKS (owner or admin): mint one (at most 30 days, a number
 *     of uses), shown ONCE; list them with their state; revoke one. While the
 *     org setting is off (the shipped default) minting is refused and the tab
 *     says so.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Input, Table, type Tone } from "../../../ui/kit";
import { QueryGate, RemoveButton, useAction } from "../adminKit";
import { FeedbackDetail, FeedbackList, type FeedbackItem } from "../../feedback/feedbackKit";
import v from "../../views.module.css";

interface LinkRow {
  id: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
  state: "active" | "expired" | "revoked" | "used_up";
}
const STATE: Record<LinkRow["state"], { label: string; tone: Tone }> = {
  active: { label: "active", tone: "ok" },
  expired: { label: "expired", tone: "neutral" },
  revoked: { label: "revoked", tone: "neutral" },
  used_up: { label: "used up", tone: "neutral" },
};

export function FeedbackTab(props: { useCaseId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const items = useQuery({
    queryKey: ["feedback", "use-case", props.useCaseId],
    queryFn: () => api.get<{ items: FeedbackItem[] }>(`/v1/feedback?useCaseId=${props.useCaseId}&status=all`),
  });
  return (
    <div className={v.stack}>
      <Card
        title="Feedback and appeals"
        actions={
          <Link to={`/feedback/${props.useCaseId}`} className={v.faint}>
            Open the report form
          </Link>
        }
      >
        <FeedbackList
          rows={items.data?.items}
          loading={items.isLoading}
          error={items.error}
          onRetry={() => void items.refetch()}
          onOpen={(r) => setOpenId(r.id)}
          showUseCase={false}
          empty={
            <EmptyState
              title="No feedback you can see"
              body="Problem reports and appeals routed to you, or every one if you are an admin, appear here. People report from the form linked above."
            />
          }
        />
      </Card>
      <SignedLinks useCaseId={props.useCaseId} />
      <FeedbackDetail
        id={openId}
        onClose={() => {
          setOpenId(null);
          void items.refetch();
        }}
      />
    </div>
  );
}

function SignedLinks(props: { useCaseId: string }) {
  const act = useAction();
  const [days, setDays] = useState("14");
  const [uses, setUses] = useState("50");
  const [minted, setMinted] = useState<{ url: string; expiresAt: string } | null>(null);
  const q = useQuery({
    queryKey: ["feedback", "links", props.useCaseId],
    queryFn: () => api.get<{ enabled: boolean; links: LinkRow[] }>(`/v1/use-cases/${props.useCaseId}/feedback-links`),
    retry: false,
  });
  const forbidden = q.error instanceof ApiError && q.error.status === 403;
  const d = Number(days);
  const n = Number(uses);
  const valid = Number.isInteger(d) && d >= 1 && d <= 30 && Number.isInteger(n) && n >= 1 && n <= 10000;
  const mint = () =>
    void act.run(async () => {
      const r = await api.post<{ path: string; expiresAt: string }>(`/v1/use-cases/${props.useCaseId}/feedback-links`, {
        expiresInDays: d,
        maxUses: n,
      });
      setMinted({ url: `${window.location.origin}${r.path}`, expiresAt: r.expiresAt });
      await q.refetch();
    }, "Link created. Copy it now: it is shown only once.");

  if (forbidden) {
    return (
      <Card title="Public signed links">
        <p className={v.hint}>Signed links are managed by the use case&apos;s owner or an admin.</p>
      </Card>
    );
  }
  return (
    <Card
      title="Public signed links"
      actions={q.data ? <Badge tone={q.data.enabled ? "warn" : "ok"}>{q.data.enabled ? "on (relaxed)" : "off (strict default)"}</Badge> : null}
    >
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && (
          <div className={v.stack}>
            {q.data.enabled ? (
              <p className={v.hint}>
                A signed link lets people outside the organisation report a problem or appeal a decision without signing in.
                It lasts at most 30 days and a set number of uses, and you can revoke it at any time.
              </p>
            ) : (
              <p className={v.hint}>
                Public signed links are off, the strict default: only signed-in users can report a problem or appeal. An
                admin can turn them on in the <Link to="/feedback">feedback settings</Link>.
              </p>
            )}
            {q.data.enabled && (
              <div className={v.row}>
                <Field label="Days valid (1–30)">
                  <Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
                </Field>
                <Field label="Uses (1–10000)">
                  <Input type="number" min={1} max={10000} value={uses} onChange={(e) => setUses(e.target.value)} />
                </Field>
                <Field label="&nbsp;">
                  <Button variant="primary" disabled={act.busy || !valid} onClick={mint}>
                    Create link
                  </Button>
                </Field>
              </div>
            )}
            {minted && (
              <div role="status" className={v.stackTight}>
                <p>
                  <strong>Copy this link now.</strong> Only a hash of it is stored, so it cannot be shown again. It works
                  until {fmtAt(minted.expiresAt)}.
                </p>
                <CodeBlock>{minted.url}</CodeBlock>
              </div>
            )}
            <Table
              rows={q.data.links}
              rowKey={(l) => l.id}
              empty={<EmptyState title="No links" body="No signed link has been created for this use case." />}
              columns={[
                { key: "created", header: "Created", render: (l) => fmtAt(l.createdAt) },
                { key: "expires", header: "Expires", render: (l) => fmtAt(l.expiresAt) },
                { key: "uses", header: "Used", render: (l) => `${l.uses} of ${l.maxUses}` },
                { key: "state", header: "State", render: (l) => <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge> },
                {
                  key: "revoke",
                  header: "",
                  render: (l) =>
                    l.state === "revoked" ? null : (
                      <RemoveButton
                        label="Revoke"
                        what={`the link created ${fmtAt(l.createdAt)}`}
                        consequence="The link stops working at once. What was already sent through it is kept."
                        onRemove={() => api.del(`/v1/use-cases/${props.useCaseId}/feedback-links/${l.id}`)}
                        onDone={() => void q.refetch()}
                      />
                    ),
                },
              ]}
            />
          </div>
        )}
      </QueryGate>
    </Card>
  );
}
