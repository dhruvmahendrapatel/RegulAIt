/**
 * ADR-0225 (P13 d) — TRUST PUBLISHING (Compliance & infra, beside Compliance packs).
 *
 * An admin chooses exactly what leaves the organisation. Nothing is published by default:
 *  - controls and evidence summaries start as drafts filled from an active compliance pack and the ledger;
 *  - AI system cards start as drafts filled from the use-case register and its systems' model cards;
 *  - every draft is edited here, and publishing (or unpublishing) asks the admin to confirm it's them;
 *  - a named external auditor gets time-limited, read-only access to chosen published items, through a sign-in link
 *    shown once. Every view the auditor makes is recorded and listed under the grant.
 * The page states requirements where the decision is made: the words a trust page may not use are flagged while
 * editing, and the publish button says what is still missing.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { fmtAt } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { putOrgSettings, withStepUp, api as stepUpApi } from "../../stepup/stepUp";
import { RefusalNotice } from "../../ui/RefusalNotice";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, InfoButton, Input, Modal, RowActions, Select, Table, Tabs, Textarea, tabIds } from "../../ui/kit";
import { KV, QueryGate, RevealCard, useAction, type RevealedSecret } from "../admin/adminKit";
import v from "../views.module.css";
import t from "./trust.module.css";
import {
  AUDITOR_MAX_DAYS,
  FIELD_LABELS,
  FIELD_MAX,
  GRANT_STATE_TONE,
  KIND_LABELS,
  LINK_TTL,
  absoluteLink,
  claimWords,
  fieldsFor,
  publishBlockers,
  type AuditorGrant,
  type TrustAudience,
  type TrustPublication,
} from "./trustModel";

const SETTING_COPY = {
  label: "Public trust pages and auditor access",
  strict: "Off: nothing is published outside the organisation, and no external auditor can be given access.",
  relaxed:
    "On lets an admin publish chosen controls, evidence summaries and AI system cards on a public page anyone can read, " +
    "and give a named auditor time-limited, read-only access to chosen items. Each publication and each auditor view is recorded.",
};

interface PublicationsResponse {
  enabled: boolean;
  items: TrustPublication[];
  truncated: boolean;
}
interface SourcesResponse {
  controls: Array<{ packId: string; controlRef: string; title: string; packTitle: string; framework: string }>;
  useCases: Array<{ id: string; name: string; status: string }>;
}
interface GrantsResponse {
  enabled: boolean;
  grants: AuditorGrant[];
}
interface GrantDetail {
  grant: AuditorGrant;
  items: Array<{ id: string; title: string; kind: string; status: string }>;
  activity: Array<{ at: string; ruleId: string; reason: string; effect: string }>;
}
interface ProfileResponse {
  enabled: boolean;
  profile: { displayName: string; intro: string; contactEmail: string | null } | null;
}


/** a button that stays focusable while it cannot act (aria-disabled plus a guard, never `disabled`) */
function GuardedButton(props: ComponentProps<typeof Button> & { blocked: boolean }) {
  const { blocked, onClick, ...rest } = props;
  return <Button {...rest} aria-disabled={blocked || undefined} onClick={(e) => (blocked ? undefined : onClick?.(e))} />;
}

/** a refusal where the action was taken: its next step when the gateway gives one, else the message */
function Refusal(props: { act: { error: string | null; guidance: Parameters<typeof RefusalNotice>[0]["guidance"] } }): ReactNode {
  if (props.act.guidance) return <RefusalNotice guidance={props.act.guidance} />;
  return props.act.error ? (
    <p role="alert" className={v.errLine}>
      {props.act.error}
    </p>
  ) : null;
}

const KEY = ["admin", "trust"] as const;
type Tab = "items" | "cards" | "auditors" | "heading";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "items", label: "Controls and evidence" },
  { id: "cards", label: "AI system cards" },
  { id: "auditors", label: "Auditor access" },
  { id: "heading", label: "Trust centre heading" },
];

export default function TrustPublishingPage() {
  const [tab, setTab] = useState<Tab>("items");
  const pubs = useQuery({ queryKey: [...KEY, "publications"], queryFn: () => api.get<PublicationsResponse>("/v1/trust/publications") });
  const ids = tabIds("trust", tab);
  return (
    <>
      <PageHeader
        title="Trust publishing"
        sub="Choose exactly which controls, evidence summaries and AI system cards are shown outside the organisation."
        info={
          <p>
            Nothing is published by default. Each item starts as a draft you edit, and publishing it asks you to confirm
            it&apos;s you. The public trust centre shows only what you published, as you worded it, and never claims a
            certification or compliance. An external auditor sees only the items you choose, for the days you choose, and
            every view is recorded.
          </p>
        }
      />
      <div className={v.stack}>
        <SettingCard enabled={pubs.data?.enabled ?? false} loading={pubs.isLoading} onSaved={() => void pubs.refetch()} />
        <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as Tab)} idPrefix="trust" label="Trust publishing" />
        <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
          {tab === "items" && <PublicationsTab query={pubs} kinds={["control", "evidence_summary"]} />}
          {tab === "cards" && <PublicationsTab query={pubs} kinds={["ai_card"]} />}
          {tab === "auditors" && <AuditorsTab published={(pubs.data?.items ?? []).filter((p) => p.status === "published")} />}
          {tab === "heading" && <HeadingTab />}
        </div>
      </div>
    </>
  );
}

// ---- the org setting -----------------------------------------------------------

function SettingCard(props: { enabled: boolean; loading: boolean; onSaved: () => void }) {
  const act = useAction();
  const [draft, setDraft] = useState<boolean | null>(null);
  const value = draft ?? props.enabled;
  const save = () =>
    void act
      .run(async () => {
        await putOrgSettings({ trustPagesEnabled: value });
        props.onSaved();
      }, value ? "Trust pages turned on. The change is recorded as a relaxation." : "Trust pages turned off. Nothing is shown outside the organisation.")
      .then((ok) => ok && setDraft(null));
  return (
    <Card title="Public trust pages">
      <div className={v.stack}>
        <div className={v.row}>
          <label className={v.row}>
            <input type="checkbox" checked={value} disabled={props.loading} onChange={(e) => setDraft(e.target.checked)} />
            <span>{SETTING_COPY.label}</span>
          </label>
          <InfoButton label={SETTING_COPY.label}>{props.enabled ? SETTING_COPY.relaxed : SETTING_COPY.strict}</InfoButton>
          {props.enabled ? <Badge tone="warn">Relaxed</Badge> : <Badge tone="ok">Strict default</Badge>}
          <span className={v.grow} />
          <GuardedButton variant="primary" size="sm" blocked={act.busy || draft === null || draft === props.enabled} onClick={save}>
            Save
          </GuardedButton>
        </div>
        <p className={v.faint}>{props.enabled ? SETTING_COPY.relaxed : SETTING_COPY.strict}</p>
        {props.enabled && (
          <p>
            The public page is at <a href="/ui/trust">/ui/trust</a>.
          </p>
        )}
        <Refusal act={act} />
      </div>
    </Card>
  );
}

// ---- controls, evidence summaries and AI system cards ------------------------------

function PublicationsTab(props: { query: ReturnType<typeof useQuery<PublicationsResponse>>; kinds: TrustPublication["kind"][] }) {
  const cards = props.kinds.includes("ai_card");
  const act = useAction();
  const [editing, setEditing] = useState<TrustPublication | null>(null);
  const [publishing, setPublishing] = useState<TrustPublication | null>(null);
  // review of #631: deleting a draft discards the admin's edited text, so it is confirmed, naming the draft
  const [deleting, setDeleting] = useState<TrustPublication | null>(null);
  const rows = (props.query.data?.items ?? []).filter((p) => props.kinds.includes(p.kind));
  const enabled = props.query.data?.enabled ?? false;
  const refresh = () => void props.query.refetch();

  const unpublish = (p: TrustPublication) =>
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`/v1/trust/publications/${p.id}/unpublish`, { expectedVersion: p.version }, h));
      refresh();
    }, `"${p.title}" is no longer shown outside the organisation.`);
  const remove = (p: TrustPublication) =>
    void act.run(async () => {
      await api.del(`/v1/trust/publications/${p.id}`);
      refresh();
    }, "Draft deleted.");

  return (
    <div className={v.stack}>
      {cards ? <NewCardDraft onCreated={(p) => { refresh(); setEditing(p); }} /> : <NewControlDraft onCreated={(p) => { refresh(); setEditing(p); }} />}
      <Card title={cards ? "AI system cards" : "Controls and evidence summaries"} count={rows.length}>
        {!enabled && !props.query.isLoading && (
          <p className={v.dim}>Public trust pages are off, so drafts can be prepared but not published. Turn them on above to publish.</p>
        )}
        <p className={v.faint}>
          Unpublishing removes an item from the public page and from every auditor&apos;s access at once. A copy of the public page
          may stay in shared web caches for up to five minutes. To show an auditor the item again after republishing, give them
          new access.
        </p>
        <Refusal act={act} />
        <Table<TrustPublication>
          rows={rows}
          loading={props.query.isLoading}
          error={props.query.error}
          onRetry={refresh}
          rowKey={(p) => p.id}
          empty={
            <EmptyState
              title={cards ? "No AI system cards yet" : "Nothing drafted yet"}
              body={cards ? "Start a card from a registered use case above." : "Start a draft from a control of an active compliance pack above."}
            />
          }
          columns={[
            { key: "title", header: "Title", render: (p) => p.title, sort: (p) => p.title },
            ...(cards ? [] : [{ key: "kind", header: "Type", render: (p: TrustPublication) => KIND_LABELS[p.kind] }]),
            {
              key: "status",
              header: "State",
              render: (p) =>
                p.status === "published" ? (
                  <Badge tone="ok">{p.audience === "public" ? "Published · public" : "Published · auditors only"}</Badge>
                ) : (
                  <Badge tone="neutral">Draft</Badge>
                ),
              sort: (p) => p.status,
            },
            { key: "updated", header: "Last change", render: (p) => fmtAt(p.publishedAt ?? p.updatedAt), sort: (p) => p.updatedAt },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              render: (p) =>
                p.status === "draft" ? (
                  <RowActions
                    primary={
                      <GuardedButton size="sm" variant="primary" blocked={!enabled || act.busy} aria-label={`Publish ${p.title}`} onClick={() => setPublishing(p)}>
                        Publish
                      </GuardedButton>
                    }
                    secondary={
                      <Button size="sm" aria-label={`Edit ${p.title}`} onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                    }
                    rest={
                      <GuardedButton size="sm" variant="ghost" blocked={act.busy} aria-label={`Delete draft ${p.title}`} onClick={() => setDeleting(p)}>
                        Delete
                      </GuardedButton>
                    }
                  />
                ) : (
                  <RowActions
                    primary={
                      <GuardedButton size="sm" blocked={act.busy} aria-label={`Unpublish ${p.title}`} onClick={() => unpublish(p)}>
                        Unpublish
                      </GuardedButton>
                    }
                  />
                ),
            },
          ]}
        />
      </Card>
      {editing && <EditModal item={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmModal
        open={deleting !== null}
        title={`Delete draft "${deleting?.title ?? ""}"?`}
        body="Your edits to this draft are lost. Nothing published is affected."
        confirmLabel="Delete draft"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const p = deleting;
          setDeleting(null);
          if (p) remove(p);
        }}
      />
      {publishing && (
        <PublishModal
          item={publishing}
          onClose={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function useSources() {
  return useQuery({ queryKey: [...KEY, "sources"], queryFn: () => api.get<SourcesResponse>("/v1/trust/sources") });
}

function NewControlDraft(props: { onCreated: (p: TrustPublication) => void }) {
  const sources = useSources();
  const act = useAction();
  const [choice, setChoice] = useState("");
  const [kind, setKind] = useState<"control" | "evidence_summary">("evidence_summary");
  const controls = sources.data?.controls ?? [];
  const create = () => {
    const [packId, ...ref] = choice.split("|");
    void act.run(async () => {
      const p = await api.post<TrustPublication>("/v1/trust/publications/from-control", { packId, controlRef: ref.join("|"), kind });
      props.onCreated(p);
    }, "Draft created from the control and the last 30 days of evidence. Edit it before publishing.");
  };
  return (
    <Card title="Start a draft from a control">
      <QueryGate loading={sources.isLoading} error={sources.error} onRetry={() => void sources.refetch()}>
        {controls.length === 0 ? (
          <EmptyState title="No active compliance pack" body="Activate a compliance pack first; its controls appear here." />
        ) : (
          <div className={v.row}>
            <Field label="Control" grow>
              <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose a control…</option>
                {controls.map((c) => (
                  <option key={`${c.packId}|${c.controlRef}`} value={`${c.packId}|${c.controlRef}`}>
                    {c.packTitle} · {c.controlRef} · {c.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Publish as">
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="evidence_summary">Evidence summary</option>
                <option value="control">Control</option>
              </Select>
            </Field>
            <Field label="&nbsp;">
              <GuardedButton variant="primary" blocked={!choice || act.busy} onClick={create}>
                Create draft
              </GuardedButton>
            </Field>
          </div>
        )}
        <Refusal act={act} />
      </QueryGate>
    </Card>
  );
}

function NewCardDraft(props: { onCreated: (p: TrustPublication) => void }) {
  const sources = useSources();
  const act = useAction();
  const [useCaseId, setUseCaseId] = useState("");
  const useCases = sources.data?.useCases ?? [];
  const create = () =>
    void act.run(async () => {
      const p = await api.post<TrustPublication>("/v1/trust/publications/from-use-case", { useCaseId });
      props.onCreated(p);
    }, "Card drafted from the register and the model cards. Edit it before publishing.");
  return (
    <Card title="Start an AI system card from the register">
      <QueryGate loading={sources.isLoading} error={sources.error} onRetry={() => void sources.refetch()}>
        {useCases.length === 0 ? (
          <EmptyState title="No registered use cases" body="Register a use case first; its card is drafted from that record." />
        ) : (
          <div className={v.row}>
            <Field label="Use case" grow>
              <Select value={useCaseId} onChange={(e) => setUseCaseId(e.target.value)}>
                <option value="">Choose a use case…</option>
                {useCases.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="&nbsp;">
              <GuardedButton variant="primary" blocked={!useCaseId || act.busy} onClick={create}>
                Draft card
              </GuardedButton>
            </Field>
          </div>
        )}
        <Refusal act={act} />
      </QueryGate>
    </Card>
  );
}

function EditModal(props: { item: TrustPublication; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [title, setTitle] = useState(props.item.title);
  const [content, setContent] = useState<Record<string, string>>({ ...props.item.content });
  const blockers = publishBlockers({ kind: props.item.kind, title, content });
  const save = () =>
    void act
      .run(async () => {
        await api.patch(`/v1/trust/publications/${props.item.id}`, { expectedVersion: props.item.version, title, content });
        props.onSaved();
      }, "Draft saved.")
      .then((ok) => ok && props.onClose());
  return (
    <Modal
      open
      wide
      title={`Edit: ${KIND_LABELS[props.item.kind]}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <GuardedButton variant="primary" blocked={act.busy || !title.trim()} onClick={save}>
            Save draft
          </GuardedButton>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.faint}>
          State facts: what the control or system is, what is on record, and how it is used. Never write that something is
          certified, compliant or guaranteed; publishing refuses those words.
        </p>
        <Field label="Title">
          <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {fieldsFor(props.item.kind).map((f) => {
          const words = claimWords(content[f] ?? "");
          return (
            <Field key={f} label={FIELD_LABELS[f]} error={words.length ? `Reword: ${words.join(", ")}` : null}>
              <Textarea rows={4} maxLength={FIELD_MAX} value={content[f] ?? ""} onChange={(e) => setContent({ ...content, [f]: e.target.value })} />
            </Field>
          );
        })}
        {blockers.length > 0 && (
          <div className={v.stackTight} aria-live="polite">
            <strong>Before this can be published</strong>
            {blockers.map((b) => (
              <span key={b} className={v.dim}>
                {b}
              </span>
            ))}
          </div>
        )}
        <Refusal act={act} />
      </div>
    </Modal>
  );
}

function PublishModal(props: { item: TrustPublication; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  // no default: who can see an item is the admin's decision, never a pre-selected permissive one (ADR-0180)
  const [audience, setAudience] = useState<TrustAudience | "">("");
  const blockers = publishBlockers(props.item);
  const publish = () =>
    void act
      .run(async () => {
        await withStepUp((h) =>
          stepUpApi.post(`/v1/trust/publications/${props.item.id}/publish`, { expectedVersion: props.item.version, audience }, h),
        );
      }, audience === "public" ? "Published on the public trust centre." : "Published for the auditors you choose.")
      .then((ok) => ok && props.onDone());
  return (
    <Modal
      open
      title={`Publish "${props.item.title}"`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <GuardedButton variant="primary" blocked={act.busy || blockers.length > 0 || audience === ""} onClick={publish}>
            Publish
          </GuardedButton>
        </>
      }
    >
      <div className={v.stack}>
        <Field label="Who can see it">
          <Select value={audience} onChange={(e) => setAudience(e.target.value as TrustAudience | "")}>
            <option value="">Choose who can see it…</option>
            <option value="public">Anyone, on the public trust centre</option>
            <option value="auditors">Only auditors you give access to</option>
          </Select>
        </Field>
        <p className={v.faint}>
          You will be asked to confirm it&apos;s you. What is shown is this text as it stands now; to change it later, unpublish
          it, edit the draft and publish again.
        </p>
        {blockers.map((b) => (
          <p key={b} role="alert" className={v.errLine}>
            {b}
          </p>
        ))}
        <Refusal act={act} />
      </div>
    </Modal>
  );
}

// ---- auditor access --------------------------------------------------------------

function AuditorsTab(props: { published: TrustPublication[] }) {
  const grants = useQuery({ queryKey: [...KEY, "grants"], queryFn: () => api.get<GrantsResponse>("/v1/trust/auditor-grants") });
  const act = useAction();
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // review of #631: revoking cannot be undone (a new grant needs a step-up and a new link), so it is confirmed
  const [revoking, setRevoking] = useState<AuditorGrant | null>(null);
  const enabled = grants.data?.enabled ?? false;
  const refresh = () => void grants.refetch();
  const showLink = (who: string, link: { path: string; expiresAt: string }) =>
    setReveal({
      title: `Sign-in link for ${who}`,
      secret: absoluteLink(window.location.origin, link.path),
      note: `Send it to the auditor yourself. It works once, until ${fmtAt(link.expiresAt)}.`,
    });
  const newLink = (g: AuditorGrant) =>
    void act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<{ link: { path: string; expiresAt: string } }>(`/v1/trust/auditor-grants/${g.id}/links`, {}, h));
      showLink(g.auditorName, out.link);
      refresh();
    }, "New link issued. Earlier unused links no longer work.");
  const revoke = (g: AuditorGrant) =>
    void act.run(async () => {
      await api.post(`/v1/trust/auditor-grants/${g.id}/revoke`, {});
      refresh();
    }, `Access for ${g.auditorName} revoked. Any open session ends now.`);

  return (
    <div className={v.stack}>
      {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}
      <NewGrant
        enabled={enabled}
        published={props.published}
        onCreated={(who, link) => {
          showLink(who, link);
          refresh();
        }}
      />
      <Card title="Auditors with access" count={grants.data?.grants.length}>
        <Refusal act={act} />
        <Table<AuditorGrant>
          rows={grants.data?.grants}
          loading={grants.isLoading}
          error={grants.error}
          onRetry={refresh}
          rowKey={(g) => g.id}
          empty={<EmptyState title="No auditor has access" body="Give a named auditor read-only access to chosen published items above." />}
          columns={[
            {
              key: "who",
              header: "Auditor",
              render: (g) => (
                <span>
                  {g.auditorName}
                  <br />
                  <span className={v.faint}>{[g.auditorEmail, g.auditorOrganisation].filter(Boolean).join(" · ")}</span>
                </span>
              ),
              sort: (g) => g.auditorName,
            },
            { key: "window", header: "Access", render: (g) => `${fmtAt(g.startsAt)} to ${fmtAt(g.expiresAt)}`, sort: (g) => g.expiresAt },
            { key: "items", header: "Items", align: "right", render: (g) => <span className={v.num}>{g.items}</span> },
            { key: "views", header: "Views", align: "right", render: (g) => <span className={v.num}>{g.views}</span> },
            { key: "state", header: "State", render: (g) => <Badge tone={GRANT_STATE_TONE[g.state]}>{g.state}</Badge>, sort: (g) => g.state },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              render: (g) => (
                <RowActions
                  primary={
                    g.state === "active" || g.state === "scheduled" ? (
                      <GuardedButton size="sm" variant="primary" blocked={!enabled || act.busy} aria-label={`New link for ${g.auditorName}`} onClick={() => newLink(g)}>
                        New link
                      </GuardedButton>
                    ) : undefined
                  }
                  secondary={
                    <Button size="sm" aria-label={`Activity of ${g.auditorName}`} onClick={() => setDetail(g.id)}>
                      Activity
                    </Button>
                  }
                  rest={
                    g.state === "active" || g.state === "scheduled" ? (
                      <GuardedButton size="sm" variant="ghost" blocked={act.busy} aria-label={`Revoke ${g.auditorName}`} onClick={() => setRevoking(g)}>
                        Revoke
                      </GuardedButton>
                    ) : undefined
                  }
                />
              ),
            },
          ]}
        />
      </Card>
      {detail && <GrantDetailModal grantId={detail} onClose={() => setDetail(null)} />}
      <ConfirmModal
        open={revoking !== null}
        title={`Revoke access for ${revoking?.auditorName ?? ""}?`}
        body="Their open session ends now and their links stop working. To give access again, create a new grant."
        confirmLabel="Revoke access"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const g = revoking;
          setRevoking(null);
          if (g) revoke(g);
        }}
      />
    </div>
  );
}

function NewGrant(props: { enabled: boolean; published: TrustPublication[]; onCreated: (who: string, link: { path: string; expiresAt: string }) => void }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [org, setOrg] = useState("");
  const [days, setDays] = useState("14");
  const [hours, setHours] = useState(String(LINK_TTL.default));
  const [chosen, setChosen] = useState<string[]>([]);
  const nDays = Number(days);
  const nHours = Number(hours);
  const problems = [
    !name.trim() && "the auditor's name",
    !/^\S+@\S+\.\S+$/.test(email.trim()) && "a valid email address",
    !(Number.isInteger(nDays) && nDays >= 1 && nDays <= AUDITOR_MAX_DAYS) && `access of 1 to ${AUDITOR_MAX_DAYS} days`,
    !(Number.isInteger(nHours) && nHours >= LINK_TTL.min && nHours <= LINK_TTL.max) && `a link valid ${LINK_TTL.min} to ${LINK_TTL.max} hours`,
    chosen.length === 0 && "at least one published item",
  ].filter(Boolean) as string[];
  const create = () =>
    void act
      .run(async () => {
        const out = await withStepUp((h) =>
          stepUpApi.post<{ link: { path: string; expiresAt: string } }>(
            "/v1/trust/auditor-grants",
            {
              auditorName: name.trim(),
              auditorEmail: email.trim(),
              auditorOrganisation: org.trim() || null,
              days: nDays,
              linkTtlHours: nHours,
              publicationIds: chosen,
            },
            h,
          ),
        );
        props.onCreated(name.trim(), out.link);
      }, "Access created. Copy the sign-in link now; it is shown once.")
      .then((ok) => {
        if (ok) {
          setName("");
          setEmail("");
          setOrg("");
          setChosen([]);
        }
      });
  if (!props.enabled) {
    return (
      <Card title="Give an auditor access">
        <EmptyState title="Auditor access is off" body="Turn on public trust pages above to give a named auditor read-only access." />
      </Card>
    );
  }
  return (
    <Card title="Give an auditor access">
      <div className={v.stack}>
        <div className={v.row}>
          <Field label="Auditor's name">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Firm (optional)">
            <Input value={org} maxLength={120} onChange={(e) => setOrg(e.target.value)} />
          </Field>
        </div>
        <div className={v.row}>
          <Field label={`Access for (days, at most ${AUDITOR_MAX_DAYS})`}>
            <Input type="number" min={1} max={AUDITOR_MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label={`Sign-in link valid for (hours, ${LINK_TTL.min} to ${LINK_TTL.max})`}>
            <Input type="number" min={LINK_TTL.min} max={LINK_TTL.max} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        </div>
        <fieldset className={`${v.stackTight} ${t.bareFieldset}`}>
          <legend className={v.sectionTitle}>Items the auditor may read</legend>
          {props.published.length === 0 ? (
            <span className={v.faint}>Nothing is published yet. Publish an item first; only published items can be shared.</span>
          ) : (
            props.published.map((p) => (
              <label key={p.id} className={v.row}>
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))}
                />
                <span>
                  {p.title} <span className={v.faint}>({KIND_LABELS[p.kind]}{p.audience === "auditors" ? ", auditors only" : ""})</span>
                </span>
              </label>
            ))
          )}
        </fieldset>
        <p className={v.faint}>
          The auditor signs in once with the link, gets a session of up to an hour, and can read only the items ticked
          here, while they stay published. Nothing can be downloaded. A new link can be issued while the access lasts.
        </p>
        {problems.length > 0 && <span className={v.dim}>Still needed: {problems.join(", ")}.</span>}
        <div>
          <GuardedButton variant="primary" blocked={act.busy || problems.length > 0} onClick={create}>
            Give access
          </GuardedButton>
        </div>
        <Refusal act={act} />
      </div>
    </Card>
  );
}

function GrantDetailModal(props: { grantId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: [...KEY, "grant", props.grantId], queryFn: () => api.get<GrantDetail>(`/v1/trust/auditor-grants/${props.grantId}`) });
  return (
    <Modal open wide title="Auditor activity" onClose={props.onClose} actions={<Button onClick={props.onClose}>Close</Button>}>
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && (
          <div className={v.stack}>
            <KV
              rows={[
                ["Auditor", `${q.data.grant.auditorName} (${q.data.grant.auditorEmail})`],
                ["Access", `${fmtAt(q.data.grant.startsAt)} to ${fmtAt(q.data.grant.expiresAt)}`],
                ["Items", q.data.items.map((i) => `${i.title}${i.status === "published" ? "" : " (unpublished, hidden)"}`).join("; ")],
              ]}
            />
            <Table
              rows={q.data.activity}
              rowKey={(r) => `${r.at}-${r.ruleId}-${r.reason.slice(0, 24)}`}
              empty={<EmptyState title="No activity yet" />}
              columns={[
                { key: "at", header: "When", render: (r) => fmtAt(r.at) },
                { key: "what", header: "What happened", render: (r) => (r.effect === "deny" ? <span className={v.errLine}>{r.reason}</span> : r.reason) },
              ]}
            />
          </div>
        )}
      </QueryGate>
    </Modal>
  );
}

// ---- the trust centre's heading -----------------------------------------------------

function HeadingTab() {
  const q = useQuery({ queryKey: [...KEY, "profile"], queryFn: () => api.get<ProfileResponse>("/v1/trust/profile") });
  const act = useAction();
  const [draft, setDraft] = useState<{ displayName: string; intro: string; contactEmail: string } | null>(null);
  const current = { displayName: q.data?.profile?.displayName ?? "", intro: q.data?.profile?.intro ?? "", contactEmail: q.data?.profile?.contactEmail ?? "" };
  const value = draft ?? current;
  const words = claimWords(`${value.displayName}\n${value.intro}`);
  const save = () =>
    void act
      .run(async () => {
        await withStepUp((h) =>
          stepUpApi.put(
            "/v1/trust/profile",
            { displayName: value.displayName.trim(), intro: value.intro, contactEmail: value.contactEmail.trim() || null },
            h,
          ),
        );
        await q.refetch();
      }, "Heading saved.")
      .then((ok) => ok && setDraft(null));
  return (
    <Card title="Trust centre heading">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div className={v.stack}>
          <Field label="Organisation name, as shown">
            <Input value={value.displayName} maxLength={120} onChange={(e) => setDraft({ ...value, displayName: e.target.value })} />
          </Field>
          <Field label="Introduction" error={words.length ? `Reword: ${words.join(", ")}` : null}>
            <Textarea rows={4} maxLength={2000} value={value.intro} onChange={(e) => setDraft({ ...value, intro: e.target.value })} />
          </Field>
          <Field label="Contact email for questions (optional)">
            <Input type="email" value={value.contactEmail} maxLength={254} onChange={(e) => setDraft({ ...value, contactEmail: e.target.value })} />
          </Field>
          <p className={v.faint}>
            {q.data?.enabled
              ? "The pages are on, so a change here is live at once and asks you to confirm it's you."
              : "The pages are off; this heading is shown once they are turned on."}
          </p>
          <div>
            <GuardedButton variant="primary" blocked={act.busy || !draft || !value.displayName.trim() || words.length > 0} onClick={save}>
              Save heading
            </GuardedButton>
          </div>
          <Refusal act={act} />
        </div>
      </QueryGate>
    </Card>
  );
}
