/**
 * Apps and agents (ADR-0337 §6; owner decision 2026-11-17), at `/admin/shadow-ai/discovery-sources/apps/:sourceId`,
 * reached from a SaaS entitlement source's row on Discovery sources.
 *
 * The vendor apps the source holds, each with its agent link: linked automatically only when its vendor app id exactly
 * matches an identifier declared for an agent, and otherwise only by an administrator (a partial or fuzzy match is
 * never linked automatically). An administrator can link, move or remove a link; a removed link is not made again
 * automatically. Below it, the vendor app identifiers declared for agents on this source's platform: declaring one
 * links every exactly matching app on every source of the platform, and removing one keeps the links it made. Every
 * change is audited by the gateway. One change runs at a time (`linksReducer`, entitlementLinksModel.ts).
 */
import { useReducer } from "react";
import { useParams } from "react-router-dom";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { errorText, fmtAt, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, IdChip, Input, Modal, Select, Table, type Column } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { QueryGate, useAgents } from "../adminKit";
import type { DiscoverySourceView } from "./discoverySourcesModel";
import { IDENTIFIERS_KEY, appsKey, declareIdentifier, fetchApps, fetchIdentifiers, linkApp, removeIdentifier, unlinkApp } from "./entitlementLinksApi";
import {
  LINK_COPY,
  SOURCE_PLATFORM,
  can,
  changeProblem,
  initialScreen,
  screenReducer,
  type AgentIdentifier,
  type Change,
  type EntitlementApp,
  type Flow,
  type Page,
} from "./entitlementLinksModel";
import v from "../../views.module.css";

const PARENT = "/admin/shadow-ai/discovery-sources";
/** the pages loaded so far as one list: its rows, whether more exist, and the first page's state for the gate */
function pages<T>(qs: Array<UseQueryResult<Page<T>>>) {
  const first = qs[0]!;
  const last = qs[qs.length - 1]!;
  return {
    rows: qs.flatMap((q) => q.data?.items ?? []),
    gate: { isLoading: first.isLoading, error: first.error, refetch: first.refetch },
    next: last.data?.nextAfter ?? null,
    loadingMore: qs.length > 1 && last.isLoading,
    moreFailed: qs.length > 1 && last.isError,
    retryMore: () => void last.refetch(),
  };
}

export default function EntitlementLinksPage() {
  const { sourceId = "" } = useParams();
  const [screen, dispatch] = useReducer(screenReducer, initialScreen);
  const flow = screen.flow;
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["admin", "discovery", "sources"], queryFn: () => api.get<{ sources: DiscoverySourceView[] }>("/v1/discovery/sources") });
  const scanners = useQuery({ queryKey: ["admin", "discovery", "scanners"], queryFn: () => api.get<{ kinds: Array<{ kind: string; label: string }> }>("/v1/discovery/scanners") });
  const agents = useAgents();
  const apps = pages(useQueries({ queries: screen.cursors.apps.map((after) => ({ queryKey: [...appsKey(sourceId), after], queryFn: () => fetchApps(sourceId, after) })) }));
  const identifiers = pages(useQueries({ queries: screen.cursors.ids.map((after) => ({ queryKey: [...IDENTIFIERS_KEY, after], queryFn: () => fetchIdentifiers(after) })) }));

  const source = sources.data?.sources.find((s) => s.id === sourceId);
  const platform = source ? SOURCE_PLATFORM[source.kind] : undefined;
  const platformLabel = (source && scanners.data?.kinds.find((k) => k.kind === source.kind)?.label) ?? "this platform";
  const agentList = agents.data?.agents ?? [];
  const agentName = (id: string | null) => (id ? (agentList.find((a) => a.id === id)?.name ?? "an agent not in the list") : "");
  const pickable = agentList.filter((a) => a.lifecycleStatus !== "retired");

  const submit = () => {
    if (flow.phase !== "editing" && flow.phase !== "failed") return;
    const c = flow.change;
    if (changeProblem(c)) return;
    if (!platform && c.kind === "declare") return;
    dispatch({ type: "submit" });
    const call: Promise<number | undefined> =
      c.kind === "link"
        ? linkApp(c.app.id, c.agentId).then(() => undefined)
        : c.kind === "unlink"
          ? unlinkApp(c.app.id).then(() => undefined)
          : c.kind === "declare"
            ? declareIdentifier({ agentId: c.agentId, platform: platform!, externalId: c.externalId })
            : removeIdentifier(c.identifier.id).then(() => undefined);
    call
      .then((autoLinked) => {
        dispatch({ type: "succeeded", autoLinked });
        void qc.invalidateQueries({ queryKey: appsKey(sourceId) });
        void qc.invalidateQueries({ queryKey: IDENTIFIERS_KEY });
      })
      .catch((e: unknown) => dispatch({ type: "failed", message: errorText(e) }));
  };

  const busy = flow.phase === "submitting";
  const notEntitlement = sources.isSuccess && (!source || !platform);
  const title = source ? `Apps and agents: ${source.name}` : "Apps and agents";

  return (
    <>
      <SubpageTrail parent="Discovery sources" parentTo={PARENT} current={title} />
      <PageHeader title={title} sub="The vendor apps this source holds, the agent each belongs to, and the app ids declared for agents." />
      <div className={v.stack}>
        {notEntitlement ? (
          <Card>
            <EmptyState title="Not a SaaS entitlement source" body="This source could not be found, or it does not hold SaaS app grants. Go back to Discovery sources to pick another." />
          </Card>
        ) : (
          <>
            <Outcome flow={flow} onDismiss={() => dispatch({ type: "dismiss" })} />
            <QueryGate query={apps.gate}>
              <AppsCard
                apps={apps.rows}
                more={apps.next != null}
                loadingMore={apps.loadingMore}
                moreFailed={apps.moreFailed}
                onMore={() => (apps.moreFailed ? apps.retryMore() : apps.next && dispatch({ type: "more", list: "apps", after: apps.next }))}
                agentName={agentName}
                busy={busy}
                onOpen={(change) => dispatch({ type: "open", change })}
              />
            </QueryGate>
            <QueryGate query={identifiers.gate}>
              <IdentifiersCard
                items={identifiers.rows.filter((i) => i.platform === platform)}
                platformLabel={platformLabel}
                more={identifiers.next != null}
                loadingMore={identifiers.loadingMore}
                onMore={() => identifiers.next && dispatch({ type: "more", list: "ids", after: identifiers.next })}
                agentName={agentName}
                busy={busy || !platform}
                onOpen={(change) => dispatch({ type: "open", change })}
              />
            </QueryGate>
          </>
        )}
      </div>
      <ChangeModal
        flow={flow}
        agents={pickable}
        agentsFailed={agents.isError}
        platformLabel={platformLabel}
        onEdit={(change) => dispatch({ type: "edit", change })}
        onSubmit={submit}
        onCancel={() => dispatch({ type: "cancel" })}
      />
    </>
  );
}

function Outcome({ flow, onDismiss }: { flow: Flow; onDismiss: () => void }) {
  if (flow.phase !== "done") return null;
  const c = flow.change;
  const what =
    c.kind === "link"
      ? "The app is linked to the agent."
      : c.kind === "unlink"
        ? "The link is removed. The app is not linked automatically again until an administrator links it."
        : c.kind === "declare"
          ? `The identifier is declared. ${flow.autoLinked ? `${plural(flow.autoLinked, "app")} with exactly that id ${flow.autoLinked === 1 ? "was" : "were"} linked automatically.` : "No app with exactly that id was found yet; matching apps are linked after each read."}`
          : "The identifier is removed. Links it made stay until an administrator removes them.";
  return (
    <Card>
      <div className={v.row}>
        <p role="status">{what}</p>
        <Button size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
    </Card>
  );
}

function AppsCard(props: {
  apps: EntitlementApp[];
  more: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onMore: () => void;
  agentName: (id: string | null) => string;
  busy: boolean;
  onOpen: (c: Change) => void;
}) {
  const columns: Array<Column<EntitlementApp>> = [
    {
      key: "app",
      header: "App",
      render: (a) => (
        <span>
          {a.displayName ?? <span className={v.dim}>No display name</span>} <IdChip id={a.externalId} />
        </span>
      ),
    },
    { key: "publisher", header: "Publisher", render: (a) => (a.publisher ? <span>{a.publisher} {a.publisherVerified ? <Badge tone="ok">Verified</Badge> : null}</span> : <span className={v.dim}>Not given</span>) },
    { key: "grants", header: "Grants", align: "right", render: (a) => a.grants },
    {
      key: "link",
      header: "Agent link",
      render: (a) => (
        <span>
          <Badge tone={LINK_COPY[a.agentLinkState].tone}>{LINK_COPY[a.agentLinkState].label}</Badge> {a.agentId ? props.agentName(a.agentId) : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      srHeader: "Actions",
      render: (a) => {
        const link = can(a, "link");
        const unlink = can(a, "unlink");
        const name = a.displayName ?? a.externalId;
        return (
          <div className={v.row}>
            {link.ok ? (
              <Button size="sm" aria-disabled={props.busy || undefined} onClick={() => !props.busy && props.onOpen({ kind: "link", app: a, agentId: a.agentId ?? "" })} aria-label={`${a.agentId ? "Change the agent for" : "Link an agent to"} ${name}`}>
                {a.agentId ? "Change agent" : "Link to an agent"}
              </Button>
            ) : (
              <span className={v.dim}>{link.why}</span>
            )}
            {unlink.ok ? (
              <Button size="sm" aria-disabled={props.busy || undefined} onClick={() => !props.busy && props.onOpen({ kind: "unlink", app: a })} aria-label={`Unlink ${name}`}>
                Unlink
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];
  return (
    <Card
      title="Apps"
      caption={<span className={v.dim}>An app is linked automatically only when its vendor app id exactly matches an identifier declared for an agent. Any other match is linked by an administrator.</span>}
      footer={
        props.more || props.moreFailed ? (
          <div className={v.row}>
            {props.moreFailed && <span className={v.errLine} role="alert">The next apps could not be loaded.</span>}
            <Button size="sm" aria-disabled={props.loadingMore || undefined} onClick={() => !props.loadingMore && props.onMore()}>
              {props.loadingMore ? "Loading…" : props.moreFailed ? "Try again" : "Load more apps"}
            </Button>
          </div>
        ) : null
      }
    >
      <Table columns={columns} rows={props.apps} rowKey={(a) => a.id} empty={<EmptyState title="No apps yet" body="This source has not recorded any vendor apps. Apps appear after the source has been read." />} />
    </Card>
  );
}

function IdentifiersCard(props: {
  items: AgentIdentifier[];
  platformLabel: string;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  agentName: (id: string | null) => string;
  busy: boolean;
  onOpen: (c: Change) => void;
}) {
  const columns: Array<Column<AgentIdentifier>> = [
    { key: "agent", header: "Agent", render: (i) => props.agentName(i.agentId) },
    { key: "id", header: "Vendor app id", render: (i) => <IdChip id={i.externalId} /> },
    { key: "at", header: "Declared", render: (i) => fmtAt(i.createdAt) },
    {
      key: "actions",
      header: "",
      srHeader: "Actions",
      render: (i) => (
        <Button size="sm" aria-disabled={props.busy || undefined} onClick={() => !props.busy && props.onOpen({ kind: "remove", identifier: i })} aria-label={`Remove the identifier ${i.externalId}`}>
          Remove
        </Button>
      ),
    },
  ];
  return (
    <Card
      title="Agent identifiers"
      caption={<span className={v.dim}>The vendor app ids declared for agents on {props.platformLabel}. An identifier applies to every source of the platform.</span>}
      actions={
        <Button size="sm" variant="primary" aria-disabled={props.busy || undefined} onClick={() => !props.busy && props.onOpen({ kind: "declare", agentId: "", externalId: "" })}>
          Declare an identifier
        </Button>
      }
      footer={
        props.more ? (
          <Button size="sm" aria-disabled={props.loadingMore || undefined} onClick={() => !props.loadingMore && props.onMore()}>
            {props.loadingMore ? "Loading…" : "Load more identifiers"}
          </Button>
        ) : null
      }
    >
      <Table columns={columns} rows={props.items} rowKey={(i) => i.id} empty={<EmptyState title="No identifiers on this platform" body="Declare an agent's vendor app id to link the apps that exactly match it." />} />
    </Card>
  );
}

function ChangeModal(props: {
  flow: Flow;
  agents: Array<{ id: string; name: string }>;
  agentsFailed: boolean;
  platformLabel: string;
  onEdit: (c: Change) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const f = props.flow;
  const open = f.phase === "editing" || f.phase === "submitting" || f.phase === "failed";
  if (!open) return <Modal open={false} title="" onClose={props.onCancel} />;
  const c = f.change;
  const busy = f.phase === "submitting";
  const problem = changeProblem(c);
  const name = c.kind === "link" || c.kind === "unlink" ? (c.app.displayName ?? c.app.externalId) : "";
  const title = c.kind === "link" ? `Link ${name} to an agent` : c.kind === "unlink" ? `Unlink ${name}` : c.kind === "declare" ? "Declare an identifier" : `Remove the identifier ${c.identifier.externalId}`;
  const confirm = c.kind === "link" ? "Link" : c.kind === "unlink" ? "Unlink" : c.kind === "declare" ? "Declare" : "Remove";
  const agentPicker = (agentId: string, set: (id: string) => void) => (
    <Field label="Agent">
      <Select value={agentId} onChange={(e) => set(e.target.value)}>
        <option value="">Choose an agent</option>
        {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </Field>
  );
  return (
    <Modal
      open
      busy={busy}
      title={title}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel} aria-disabled={busy || undefined}>Cancel</Button>
          <Button variant={c.kind === "unlink" || c.kind === "remove" ? "danger" : "primary"} aria-disabled={busy || problem != null || undefined} aria-describedby={problem ? "link-change-problem" : undefined} onClick={() => !busy && !problem && props.onSubmit()}>
            {busy ? "Saving…" : f.phase === "failed" ? `Try again: ${confirm}` : confirm}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {props.agentsFailed && (c.kind === "link" || c.kind === "declare") && <p className={v.errLine} role="alert">The agent list could not be loaded, so no agent can be chosen.</p>}
        {c.kind === "link" && (
          <>
            <p>The link is audited. Linking by hand is how a partial or fuzzy match is linked; nothing is linked automatically unless the ids match exactly.</p>
            {agentPicker(c.agentId, (agentId) => props.onEdit({ ...c, agentId }))}
          </>
        )}
        {c.kind === "unlink" && <p>The link is removed and audited. This app is not linked automatically again until an administrator links it.</p>}
        {c.kind === "declare" && (
          <>
            <p>Every app on {props.platformLabel} whose vendor app id exactly matches is linked to the agent, on every source of the platform. Each link is audited.</p>
            {agentPicker(c.agentId, (agentId) => props.onEdit({ ...c, agentId }))}
            <Field label="Vendor app id">
              <Input value={c.externalId} maxLength={255} spellCheck={false} onChange={(e) => props.onEdit({ ...c, externalId: e.target.value.trim() })} />
            </Field>
          </>
        )}
        {c.kind === "remove" && <p>The identifier is removed and audited. The apps it linked stay linked until an administrator unlinks them.</p>}
        {problem && <p id="link-change-problem" className={v.dim}>{problem}</p>}
        {f.phase === "failed" && <p className={v.errLine} role="alert">Nothing changed: {f.message}</p>}
      </div>
    </Modal>
  );
}
