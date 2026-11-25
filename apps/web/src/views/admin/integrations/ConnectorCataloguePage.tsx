/**
 * The governed connector catalogue (ADR-0255), at `connectors/catalogue`: the curated pieces RegulAIt has a governed
 * adapter for, each off until an admin enables it, and the rest of the community catalogue, listed as available, not
 * enabled (paginated, searched on the server).
 *
 * Enabling widens what the deployment reaches, so it needs a reason and the gateway asks for a step-up
 * (`settings_relax`); disabling needs a reason only. Both are audited by the gateway. The screen's search, paging and
 * the enable/disable flow are one reducer (`catalogueReducer`, connectorCatalogueModel.ts); this file renders its state.
 * Enabling a piece grants nobody anything: people still need a connector and a grant.
 */
import { useEffect, useId, useReducer, useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtAt, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, RowActions, Table, Textarea } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { rangeText } from "../../../ui/listState";
import { useToast } from "../../../ui/toast";
import { QueryGate, adminKeys, useUsers } from "../adminKit";
import { CATALOGUE_KEY, fetchCatalogue, setPieceEnablement } from "./connectorCatalogueApi";
import {
  COMMUNITY_BLOCKED,
  PAGE_SIZE,
  Q_MAX,
  REASON_MAX,
  SEARCH_DEBOUNCE_MS,
  actionsSummary,
  catalogueReducer,
  curatedAction,
  initialCatalogueState,
  readStateOf,
  reasonProblem,
  statusLabel,
  type CommunityPiece,
  type CuratedPiece,
  type Flow,
} from "./connectorCatalogueModel";
import v from "../../views.module.css";

export default function ConnectorCataloguePage() {
  const [state, dispatch] = useReducer(catalogueReducer, initialCatalogueState);
  const { flow } = state;
  const isAdmin = useSession().auth?.isAdmin === true;
  const qc = useQueryClient();
  const { toast } = useToast();
  const users = useUsers();

  // the search runs on the server, a moment after typing stops
  useEffect(() => {
    const t = window.setTimeout(() => dispatch({ type: "searchSettled" }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [state.input]);

  const query = useQuery({
    queryKey: [...CATALOGUE_KEY, state.q, state.offset],
    queryFn: () => fetchCatalogue({ q: state.q, offset: state.offset }),
    placeholderData: keepPreviousData,
  });
  const read = readStateOf(query, state.q);

  // one request per transition into "submitting"; the reducer owns every outcome, and decides whether there is one
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = () => {
    const next = catalogueReducer(state, { type: "submit" }).flow;
    dispatch({ type: "submit" });
    if (next.phase !== "submitting") return;
    const { target, reason } = next;
    const send = (e: Parameters<typeof dispatch>[0]) => mounted.current && dispatch(e);
    setPieceEnablement(target.key, { enabled: target.intent === "enable", reason }, () => send({ type: "stepUpRequested" }))
      .then(() => {
        send({ type: "succeeded" });
        toast(`${target.displayName} ${target.intent === "enable" ? "enabled" : "disabled"}`, "success");
        void qc.invalidateQueries({ queryKey: CATALOGUE_KEY });
        void qc.invalidateQueries({ queryKey: adminKeys.connectors });
      })
      .catch((error: unknown) => send({ type: "failed", error }));
  };

  const who = (id: string | null) => (id ? users.data?.users.find((u) => u.id === id)?.displayName ?? "an admin" : "the bootstrap token");
  const data = read.kind === "ready" ? read.data : null;
  const runnable = data?.runnable ?? true;

  return (
    <>
      <SubpageTrail parent="Connectors" parentTo="/admin/connectors" current="Connector catalogue" />
      <PageHeader
        title="Connector catalogue"
        sub="Community connector pieces, each off until an administrator enables it."
        info={
          <p>
            A curated piece has a governed adapter: its calls run through the same entitlement, cost, approval and audit checks as any connector.
            Enabling one grants nobody anything; people still need a connector of that kind and a grant. The rest of the community catalogue is
            listed so you can see what exists; it cannot be enabled until an adapter is built.
          </p>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={read.kind === "loading"} error={read.kind === "error" ? read.error : null} onRetry={() => void query.refetch()}>
          {data && !runnable && (
            <p role="note" className={v.errLine} data-testid="catalogue-air-gapped">
              This deployment is air-gapped. Catalogue pieces call public SaaS APIs, so none can run here, enabled or not, and none can be enabled.
            </p>
          )}
          <FlowStatus flow={flow} onRetry={submit} onDismiss={() => dispatch({ type: "dismiss" })} />
          <Card title="Curated pieces" count={data ? data.curated.length : null} countNoun={["piece", "pieces"]}>
            <Table<CuratedPiece>
              columns={[
                {
                  key: "piece",
                  header: "Piece",
                  sort: (p) => p.displayName,
                  render: (p) => (
                    <>
                      {p.displayName} <span className={`${v.mono} ${v.dim}`}>{p.key}</span>
                    </>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (p) => <Badge tone={p.status === "enabled" ? "ok" : "neutral"}>{statusLabel(p.status)}</Badge>,
                },
                {
                  key: "actions",
                  header: "Actions it offers",
                  render: (p) => (
                    <>
                      {actionsSummary(p.actions)}
                      <div className={v.dim}>{p.actions.map((a) => a.displayName).join(", ")}</div>
                    </>
                  ),
                },
                { key: "upstream", header: "Upstream", render: (p) => <span className={v.mono}>{`${p.upstream?.npm ?? ""} ${p.upstream?.version ?? ""}`.trim()}</span> },
                {
                  key: "enabled",
                  header: "Enabled",
                  render: (p) => (p.status === "enabled" && p.enabledAt ? `${fmtAt(p.enabledAt)} by ${who(p.enabledByUserId)}` : "Not enabled"),
                },
                {
                  key: "change",
                  header: "",
                  srHeader: "Actions",
                  render: (p) => <CuratedRowAction piece={p} isAdmin={isAdmin} runnable={runnable} flow={flow} onOpen={(t) => dispatch({ type: "open", target: t })} />,
                },
              ]}
              rows={data?.curated}
              rowKey={(p) => p.key}
              empty={<EmptyState title="No curated pieces" body="This build ships no governed piece adapters." />}
            />
          </Card>
          {data && (
            <CommunityCard
              input={state.input}
              q={state.q}
              offset={state.offset}
              items={data.available.items}
              total={data.available.total}
              empty={read.kind === "ready" ? read.communityEmpty : null}
              refreshing={query.isPlaceholderData}
              error={query.isError ? query.error : null}
              onRetry={() => void query.refetch()}
              onType={(input) => dispatch({ type: "typed", input })}
              onPage={(offset) => dispatch({ type: "page", offset })}
              source={data.available.source}
            />
          )}
        </QueryGate>
      </div>
      <ConfirmChange flow={flow} onReason={(reason) => dispatch({ type: "reasonEdited", reason })} onSubmit={submit} onCancel={() => dispatch({ type: "cancel" })} />
    </>
  );
}

function CuratedRowAction(props: { piece: CuratedPiece; isAdmin: boolean; runnable: boolean; flow: Flow; onOpen: (t: { key: string; displayName: string; intent: "enable" | "disable" }) => void }) {
  const why = useId();
  const { piece: p } = props;
  const a = curatedAction(p, { isAdmin: props.isAdmin, runnable: props.runnable, flow: props.flow });
  const button = (
    <Button
      size="sm"
      variant={a.intent === "enable" ? "primary" : "danger"}
      aria-label={`${a.label} ${p.displayName}`}
      aria-disabled={a.blocked ? true : undefined}
      aria-describedby={a.blocked ? why : undefined}
      onClick={() => !a.blocked && props.onOpen({ key: p.key, displayName: p.displayName, intent: a.intent })}
    >
      {a.label}
    </Button>
  );
  return (
    <>
      {/* a tightening (Disable) is never in the primary slot */}
      <RowActions primary={a.intent === "enable" ? button : null} secondary={a.intent === "disable" ? button : null} />
      {a.blocked && (
        <span id={why} className={v.dim}>
          {a.blocked}
        </span>
      )}
    </>
  );
}

function CommunityCard(props: {
  input: string;
  q: string;
  offset: number;
  items: CommunityPiece[];
  total: number;
  empty: "none" | "no_match" | null;
  refreshing: boolean;
  error: unknown;
  onRetry: () => void;
  onType: (input: string) => void;
  onPage: (offset: number) => void;
  source: { repository: string; commit: string } | null;
}) {
  const why = useId();
  const more = props.offset + props.items.length < props.total;
  const range = rangeText(props.offset, props.items.length, props.total, false, more);
  return (
    <Card
      title="Community pieces"
      count={props.total}
      countNoun={["piece", "pieces"]}
      caption={props.source ? <span className={v.dim}>Listed from {props.source.repository} at commit {props.source.commit.slice(0, 12)}. Names and versions only; no piece code is included.</span> : null}
      footer={
        <div className={v.row} aria-busy={props.refreshing || undefined}>
          <span aria-live="polite">{range || (props.q ? "No pieces match" : "")}</span>
          <Button size="sm" aria-disabled={props.offset === 0 || undefined} onClick={() => props.offset > 0 && props.onPage(Math.max(0, props.offset - PAGE_SIZE))}>
            Previous
          </Button>
          <Button size="sm" aria-disabled={!more || undefined} onClick={() => more && props.onPage(props.offset + PAGE_SIZE)}>
            Next
          </Button>
        </div>
      }
    >
      <div className={v.row}>
        <Field label="Search community pieces">
          <Input type="search" value={props.input} maxLength={Q_MAX} spellCheck={false} placeholder="Piece name, for example sheets" onChange={(e) => props.onType(e.target.value)} />
        </Field>
      </div>
      <p id={why} className={v.dim}>
        {COMMUNITY_BLOCKED}
      </p>
      <Table<CommunityPiece>
        columns={[
          { key: "key", header: "Piece", render: (p) => <span className={v.mono}>{p.key}</span> },
          { key: "npm", header: "Package", render: (p) => <span className={v.mono}>{`${p.npm} ${p.version}`}</span> },
          { key: "status", header: "Status", render: (p) => <Badge>{statusLabel(p.status)}</Badge> },
          {
            key: "change",
            header: "",
            srHeader: "Actions",
            render: (p) => (
              <RowActions
                primary={
                  <Button size="sm" aria-label={`Enable ${p.key}`} aria-disabled aria-describedby={why} onClick={() => undefined}>
                    Enable
                  </Button>
                }
              />
            ),
          },
        ]}
        rows={props.items}
        rowKey={(p) => p.key}
        error={props.error}
        onRetry={props.onRetry}
        empty={
          props.empty === "no_match" ? (
            <EmptyState title="No pieces match" body="Try a different search." />
          ) : (
            <EmptyState title="No community pieces listed" />
          )
        }
      />
    </Card>
  );
}

/** the outcome of the change in flight or just made, where the person is looking; a refusal stays until dismissed */
function FlowStatus(props: { flow: Flow; onRetry: () => void; onDismiss: () => void }) {
  const f = props.flow;
  if (f.phase === "idle" || f.phase === "confirming") return null;
  const name = f.target.displayName;
  const verb = f.target.intent === "enable" ? "Enabling" : "Disabling";
  if (f.phase === "submitting") return <p role="status" className={v.dim} data-testid="catalogue-flow">{`${verb} ${name}…`}</p>;
  if (f.phase === "steppingUp")
    return <p role="status" className={v.dim} data-testid="catalogue-flow">{`${verb} ${name} widens what this deployment reaches. Confirm it's you in the dialog to continue.`}</p>;
  if (f.phase === "done")
    return (
      <div className={v.row} data-testid="catalogue-flow">
        <p role="status">{f.message}. The change is in the audit log.</p>
        <Button size="sm" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  return (
    <div className={v.row} data-testid="catalogue-flow">
      <p role="alert" className={v.errLine}>
        {f.phase === "stepUpDeclined" ? `${name} was not ${f.target.intent}d: you did not confirm it's you. Nothing changed.` : f.error}
      </p>
      <Button size="sm" onClick={props.onRetry}>
        Try again
      </Button>
      <Button size="sm" onClick={props.onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function ConfirmChange(props: { flow: Flow; onReason: (r: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const f = props.flow;
  const why = useId();
  const open = f.phase === "confirming";
  const target = open ? f.target : null;
  const reason = open ? f.reason : "";
  const problem = reasonProblem(reason);
  const enable = target?.intent === "enable";
  const label = target ? `${enable ? "Enable" : "Disable"} ${target.displayName}` : "Confirm";
  return (
    <Modal
      open={open}
      title={target ? `${label}?` : "Confirm"}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button
            variant={enable ? "primary" : "danger"}
            aria-disabled={problem ? true : undefined}
            aria-describedby={problem ? why : undefined}
            onClick={props.onSubmit}
          >
            {label}
          </Button>
        </>
      }
    >
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <p>
          {enable
            ? "Connectors of this kind can then be created and called, still only by the people granted them. You will be asked to confirm it's you."
            : "Connectors of this kind are refused from then on, on every call, until it is enabled again."}
        </p>
        <Field label="Reason (required, audited)" error={open && f.touched ? problem : null} grow>
          <Textarea value={reason} rows={2} maxLength={REASON_MAX} onChange={(e) => props.onReason(e.target.value)} />
        </Field>
        {problem && (
          <p id={why} className={v.dim}>
            {`${label} is unavailable until there is a reason: ${problem}`}
          </p>
        )}
        <p className={v.dim}>{`${plural(REASON_MAX, "character")} at most. The audit log keeps who changed it, when and why.`}</p>
      </form>
    </Modal>
  );
}

