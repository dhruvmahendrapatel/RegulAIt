/**
 * Agent stewardship (ADR-0168 item 6) on the agent inventory: every agent is a
 * non-human identity with a named steward, a successor who takes over when the
 * steward leaves, a lifecycle status and a review date.
 *
 *  - StewardshipCard: filter chips (all / orphaned / review overdue) and one row
 *    per agent; "Manage" opens the drawer.
 *  - StewardshipDrawer: change steward, successor, status and next review in one
 *    audited save, or record that a review happened today ("Record review").
 *  - AgentStewardshipLine: the one-line summary the use-case record's Stack tab
 *    shows under each agent.
 *
 * The gateway owns the rules (who may act, steward ≠ successor, reasons,
 * retirement); refusals surface in its own words.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { AdminAgent, AdminUser } from "../../../api/adminTypes";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import { useSession } from "../../../session/SessionContext";
import {
  LIFECYCLE_EFFECT,
  cadenceSentence,
  draftOf,
  fmtDay,
  lifecycleChoices,
  lifecycleLabel,
  lifecycleTone,
  matchesFilter,
  reviewCell,
  stewardReviewLimit,
  stewardshipPatch,
  type AgentStewardship,
  type StewardshipDraft,
  type StewardshipFilter,
} from "./agentStewardshipModel";
import st from "./agentStewardship.module.css";
import v from "../../views.module.css";

type Row = AdminAgent & AgentStewardship;

const FILTERS: Array<{ value: StewardshipFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "orphaned", label: "Orphaned" },
  { value: "overdue", label: "Review overdue" },
];

function Flags({ a }: { a: AgentStewardship }) {
  if (!a.orphaned && !a.reviewOverdue) return <span className={st.none}>—</span>;
  return (
    <span className={st.flags}>
      {a.orphaned ? (
        <Badge tone="danger" title={a.stewardDeactivated ? "The steward's account is deactivated" : "No steward is named"}>
          Orphaned
        </Badge>
      ) : null}
      {a.reviewOverdue ? <Badge tone="warn">Review overdue</Badge> : null}
    </span>
  );
}

function personCell(name: string | null | undefined, deactivated: boolean | undefined, none: string) {
  if (!name) return <span className={st.none}>{none}</span>;
  return deactivated ? (
    <>
      {name} <Badge tone="warn">Deactivated</Badge>
    </>
  ) : (
    name
  );
}

export function StewardshipCard(props: {
  agents: Row[] | undefined;
  users: AdminUser[] | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const [filter, setFilter] = useState<StewardshipFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  // a failed agent list is reported once, by the catalog below — not twice
  if (props.failed) return null;
  const rows = props.agents ?? [];
  const count = (f: StewardshipFilter) => rows.filter((a) => matchesFilter(a, f)).length;
  const shown = rows.filter((a) => matchesFilter(a, filter));
  const open = rows.find((a) => a.id === openId);

  return (
    <Card flush title="Stewardship">
      <div className={st.toolbar}>
        <p className={st.intro}>
          Every agent needs a steward who answers for it, a successor who takes over when the steward leaves, and a
          regular review.
        </p>
      </div>
      <div className={st.toolbar}>
        <div className={st.chips} role="group" aria-label="Stewardship filter">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={st.chip}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label} <span className={st.chipCount}>{count(f.value)}</span>
            </button>
          ))}
        </div>
      </div>
      <Table<Row>
        columns={[
          {
            key: "agent",
            header: "Agent",
            sort: (a) => a.name,
            render: (a) => (
              <span className={st.nameCell}>
                <span className={st.nameText}>{a.name}</span>
                {a.highestUseCaseTier ? <span className={st.sub}>Riskiest use case: {a.highestUseCaseTier}</span> : null}
              </span>
            ),
          },
          { key: "steward", header: "Steward", sort: (a) => a.stewardName ?? "", render: (a) => personCell(a.stewardName, a.stewardDeactivated, "No steward") },
          { key: "successor", header: "Successor", render: (a) => personCell(a.successorName, a.successorDeactivated, "None named") },
          {
            key: "lifecycle",
            header: "Status",
            sort: (a) => a.lifecycleStatus ?? "",
            render: (a) => <Badge tone={lifecycleTone(a.lifecycleStatus ?? "active")}>{lifecycleLabel(a.lifecycleStatus ?? "active")}</Badge>,
          },
          {
            key: "review",
            header: "Next review",
            sort: (a) => a.nextReviewAt ?? "9999",
            render: (a) => {
              const c = reviewCell(a);
              return <span className={c.overdue ? st.overdue : c.text === "Not scheduled" ? st.none : undefined}>{c.text}</span>;
            },
          },
          { key: "flags", header: "Flags", render: (a) => <Flags a={a} /> },
          {
            key: "manage",
            header: "",
            align: "right",
            render: (a) => (
              <Button
                size="sm"
                aria-label={`Manage stewardship of ${a.name}`}
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setOpenId(a.id);
                }}
              >
                Manage
              </Button>
            ),
          },
        ]}
        rows={shown}
        rowKey={(a) => a.id}
        loading={props.loading}
        empty={
          filter === "all" ? (
            <EmptyState title="No agents registered" />
          ) : (
            <EmptyState title={filter === "orphaned" ? "No orphaned agents" : "No overdue reviews"} body="Every agent passes this check." />
          )
        }
      />
      {open ? (
        <StewardshipDrawer
          agent={open}
          users={props.users ?? []}
          onClose={() => {
            setOpenId(null);
            opener.current?.focus();
          }}
        />
      ) : null}
    </Card>
  );
}

export function StewardshipDrawer(props: { agent: Row; users: AdminUser[]; onClose: () => void }) {
  const a = props.agent;
  const act = useAction();
  const review = useAction();
  const [draft, setDraft] = useState<StewardshipDraft>(() => draftOf(a));
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { onClose } = props;
  const retired = a.lifecycleStatus === "retired";
  // ADR-0170 item 7: a steward who is not an admin is offered only the moves the
  // gateway allows them; an admin keeps every choice
  const { auth } = useSession();
  const isAdmin = Boolean(auth?.isAdmin);
  const statusChoices = lifecycleChoices(a.lifecycleStatus ?? "active", isAdmin);

  // a different agent (or the saved version of this one) starts from its own record
  const recordKey = `${a.id}|${a.stewardUserId ?? a.ownerUserId}|${a.successorUserId}|${a.lifecycleStatus}|${a.lifecycleReason}|${a.nextReviewAt}`;
  useEffect(() => {
    setDraft(draftOf(a));
    setProblem(null);
  }, [recordKey]); // the record's identity, not the object (a refetch makes a new one)
  useEffect(() => {
    heading.current?.focus();
  }, [a.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // active people are choosable; a current pick who has since been deactivated
  // stays listed (marked) so the field shows the truth until it is changed
  const people = useMemo(() => {
    const keep = new Set([a.stewardUserId ?? a.ownerUserId, a.successorUserId].filter(Boolean));
    return props.users
      .filter((u) => !u.disabledAt || keep.has(u.id))
      .map((u) => ({ id: u.id, label: `${u.displayName || u.email}${u.disabledAt ? " (deactivated)" : ""}` }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [props.users, a.stewardUserId, a.ownerUserId, a.successorUserId]);

  const set = (k: keyof StewardshipDraft, val: string) => {
    setProblem(null);
    setDraft((d) => ({ ...d, [k]: val }));
  };
  // dirty, not "valid": a draft with a problem still submits, so the form can say what is wrong
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(a));
  const needsReason = draft.lifecycleStatus !== "active";

  return (
    <aside className={st.drawer} role="dialog" aria-modal="false" aria-labelledby="stewardship-title">
      <div className={st.drawerHead}>
        <div className={st.drawerTitleBlock}>
          <span className={st.drawerType}>Agent stewardship</span>
          <h2 id="stewardship-title" ref={heading} tabIndex={-1} className={st.drawerTitle}>
            {a.name}
          </h2>
          <div className={v.row}>
            <Badge tone={lifecycleTone(a.lifecycleStatus ?? "active")}>{lifecycleLabel(a.lifecycleStatus ?? "active")}</Badge>
            <Flags a={a} />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onClose} aria-label="Close stewardship">
          Close
        </Button>
      </div>
      <div className={st.drawerBody}>
        {a.orphaned ? (
          <div className={st.flag} role="note">
            <Badge tone="danger">Orphaned</Badge>
            <span>
              {a.stewardDeactivated ? `${a.stewardName ?? "The steward"}'s account is deactivated.` : "No steward is named."}
              {a.successorName && !a.successorDeactivated ? ` ${a.successorName} is the named successor.` : " Name a steward below."}
            </span>
          </div>
        ) : null}

        <dl className={st.facts}>
          <dt>Last review</dt>
          <dd>{a.lastReviewedAt ? `${fmtDay(a.lastReviewedAt)}${a.lastReviewedByName ? ` by ${a.lastReviewedByName}` : ""}` : "Never recorded"}</dd>
          <dt>Next review</dt>
          <dd className={a.reviewOverdue ? st.overdue : undefined}>{reviewCell(a).text}</dd>
          <dt>Cadence</dt>
          <dd>{cadenceSentence(a)}</dd>
        </dl>

        <form
          className={st.section}
          aria-labelledby="stewardship-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const out = stewardshipPatch(a, draft, undefined, { isAdmin });
            if (out.problem) return setProblem(out.problem);
            if (!out.body) return;
            // ADR-0186 A: a new steward is an owner change, and lifting a suspension a
            // relaxation — the gateway asks the admin or steward to confirm it's them
            void act.run(
              () => withStepUp((h) => stepUpApi.patch(`/v1/agents/${a.id}/stewardship`, out.body, h)),
              "Stewardship saved",
            );
          }}
        >
          <h3 id="stewardship-edit" className={st.sectionTitle}>Steward and lifecycle</h3>
          <Field label="Steward">
            <Select value={draft.stewardUserId} onChange={(e) => set("stewardUserId", e.target.value)}>
              <option value="">No steward</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Successor">
            <Select value={draft.successorUserId} onChange={(e) => set("successorUserId", e.target.value)}>
              <option value="">None named</option>
              {people
                .filter((p) => p.id !== draft.stewardUserId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={draft.lifecycleStatus}
              disabled={retired || statusChoices.length < 2}
              onChange={(e) => set("lifecycleStatus", e.target.value)}
            >
              {statusChoices.map((s) => (
                <option key={s} value={s}>
                  {lifecycleLabel(s)}
                </option>
              ))}
            </Select>
          </Field>
          <p className={st.help}>{LIFECYCLE_EFFECT[draft.lifecycleStatus as keyof typeof LIFECYCLE_EFFECT] ?? ""}</p>
          {!isAdmin && !retired ? (
            <p className={st.help}>
              As steward you can put this agent under review or suspend it. Only an admin can return it to service, retire
              it or clear its next review.
            </p>
          ) : null}
          {needsReason && !retired ? (
            <Field label="Reason for this status">
              <Textarea rows={2} value={draft.lifecycleReason} onChange={(e) => set("lifecycleReason", e.target.value)} />
            </Field>
          ) : null}
          <Field label="Next review">
            {/* no `min`: an overdue agent's stored date is in the past, and a min would make the
                browser block every save of it; a NEW past date is refused in words instead */}
            <Input type="date" value={draft.nextReview} onChange={(e) => set("nextReview", e.target.value)} />
          </Field>
          {!isAdmin && !retired ? (
            <p className={st.help}>Choose a date on or before {fmtDay(`${stewardReviewLimit(a)}T12:00:00Z`)}.</p>
          ) : null}
          <div className={st.actions}>
            <Button type="submit" variant="primary" disabled={act.busy || !dirty}>
              Save changes
            </Button>
            {problem || act.error ? (
              <span className={v.errLine} role="alert">
                {problem ?? act.error}
              </span>
            ) : null}
          </div>
        </form>

        <section className={st.section} aria-labelledby="stewardship-review">
          <h3 id="stewardship-review" className={st.sectionTitle}>Lifecycle review</h3>
          <p className={st.help}>
            {retired
              ? "A retired agent is out of service for good, so there is nothing left to review."
              : "Record that you reviewed this agent today: its purpose, access and steward still hold. The next review is scheduled by the cadence above."}
          </p>
          <div className={st.actions}>
            <Button
              disabled={retired || review.busy}
              onClick={() => void review.run(() => api.post(`/v1/agents/${a.id}/stewardship/review`, {}), "Review recorded")}
            >
              Record review
            </Button>
            {review.error ? (
              <span className={v.errLine} role="alert">
                {review.error}
              </span>
            ) : null}
          </div>
        </section>
      </div>
    </aside>
  );
}

/** the use-case record's Stack tab: who stewards this agent, and whether it is orphaned */
export function AgentStewardshipLine(props: { stewardship: AgentStewardship | undefined }) {
  const s = props.stewardship;
  if (!s) return null;
  return (
    <p className={st.stackLine}>
      <span>
        Steward: {s.stewardName ?? "none"}
        {s.stewardDeactivated ? " (deactivated)" : ""}
        {" · "}Successor: {s.successorName ?? "none named"}
      </span>
      {s.orphaned ? <Badge tone="danger">Orphaned</Badge> : null}
      {s.reviewOverdue ? <Badge tone="warn">Review overdue</Badge> : null}
    </p>
  );
}
