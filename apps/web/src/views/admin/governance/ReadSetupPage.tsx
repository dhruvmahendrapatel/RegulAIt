/**
 * A SaaS entitlement source's read setup (ADR-0337 §4a, §5a; owner decision D-2026-11-22-06), at
 * `/admin/shadow-ai/discovery-sources/read-setup/:sourceId`, reached from the source's row on Discovery sources.
 *
 * Microsoft 365: the guided Entra activity-log setup. It is off by default; the checklist gives the exact admin steps
 * and the consent link from the gateway, and the state is the one the latest read observed: "Not checked yet" until a
 * read has looked, "Not enabled" while the tenant side is missing, and "Connected" only when sign-ins are arriving.
 * Salesforce: what the least-privilege read sees and cannot see, and the org-wide token opt-in with its trade-off. That
 * opt-in needs two keys, the audited org switch and the source's own request. Widening either is a step-up the gateway
 * asks for and audits. One change runs at a time (`readSetupReducer`, readSetupModel.ts); this file renders its state.
 */
import { useReducer } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { errorText, fmtAt } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { QueryGate } from "../adminKit";
import type { DiscoverySettingsView, DiscoverySourceView } from "./discoverySourcesModel";
import { SETTINGS_KEY, SOURCES_KEY, fetchReadSetup, readSetupKey, setOrgTokensSwitch, setSourceKey } from "./readSetupApi";
import { ACTIVITY_COPY, changeCopy, readSetupReducer, type Change, type Flow, type M365Setup, type ReadSetup, type SalesforceSetup } from "./readSetupModel";
import v from "../../views.module.css";

const PARENT = "/admin/shadow-ai/discovery-sources";

export default function ReadSetupPage() {
  const { sourceId = "" } = useParams();
  const [flow, dispatch] = useReducer(readSetupReducer, { phase: "idle" } as Flow);
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: readSetupKey(sourceId), queryFn: () => fetchReadSetup(sourceId) });
  const sources = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: () => api.get<{ sources: DiscoverySourceView[] }>("/v1/discovery/sources"),
  });
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<DiscoverySettingsView>("/v1/discovery/settings") });
  const source = sources.data?.sources.find((s) => s.id === sourceId);

  const run = (change: Change) => {
    const next = readSetupReducer(flow, { type: "submit" });
    dispatch({ type: "submit" });
    if (next.phase !== "submitting") return;
    const stepped = () => dispatch({ type: "stepUpRequested" });
    const call =
      change.kind === "orgSwitch"
        ? settings.data
          ? setOrgTokensSwitch(settings.data, change.on, stepped)
          : Promise.reject(new Error("The discovery settings are not loaded, so nothing was changed."))
        : source
          ? setSourceKey(source, change.kind === "activityLogs" ? "activityLogs" : "orgTokens", change.on, stepped)
          : Promise.reject(new Error("The source is not loaded, so nothing was changed."));
    call
      .then(() => {
        dispatch({ type: "succeeded" });
        void qc.invalidateQueries({ queryKey: SOURCES_KEY });
        void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
        void qc.invalidateQueries({ queryKey: readSetupKey(sourceId) });
      })
      .catch((e: unknown) => dispatch({ type: "failed", error: e, message: errorText(e) }));
  };

  const title = source ? `Read setup: ${source.name}` : "Read setup";
  const notFound = setup.error instanceof ApiError && setup.error.status === 404;
  const noSetup = setup.error instanceof ApiError && setup.error.status === 409;
  const tradeOff = setup.data?.platform === "salesforce" ? setup.data.orgTokens.tradeOff : undefined;
  const pending = flow.phase === "confirming" ? changeCopy(flow.change, tradeOff) : null;

  return (
    <>
      <SubpageTrail parent="Discovery sources" parentTo={PARENT} current={title} />
      <PageHeader title={title} sub="What this entitlement source's read can see, and the admin steps that widen it." />
      <div className={v.stack}>
        {notFound ? (
          <Card>
            <EmptyState title="No such source" body="It may have been deleted. Go back to Discovery sources to pick another." />
          </Card>
        ) : noSetup ? (
          <Card>
            <EmptyState title="No guided read setup for this source" body="Only Microsoft 365 and Salesforce entitlement sources have one." />
          </Card>
        ) : (
          <QueryGate query={setup}>
            {setup.data && (
              <>
                <FlowCard flow={flow} onRetry={() => "change" in flow && run(flow.change)} onDismiss={() => dispatch({ type: "dismiss" })} />
                {setup.data.platform === "m365" ? (
                  <M365View data={setup.data} source={source} sourceMissing={sources.isSuccess && !source} busy={flow.phase === "submitting" || flow.phase === "stepping"} onAsk={(c) => dispatch({ type: "ask", change: c })} />
                ) : (
                  <SalesforceView
                    data={setup.data}
                    source={source}
                    sourceMissing={sources.isSuccess && !source}
                    settings={settings.data}
                    settingsFailed={settings.isError}
                    busy={flow.phase === "submitting" || flow.phase === "stepping"}
                    onAsk={(c) => dispatch({ type: "ask", change: c })}
                  />
                )}
                <LastReadCard data={setup.data} />
              </>
            )}
          </QueryGate>
        )}
      </div>
      <ConfirmModal
        open={pending != null}
        title={pending?.title ?? ""}
        body={<p>{pending?.body}</p>}
        confirmLabel={pending?.confirm}
        onConfirm={() => flow.phase === "confirming" && run(flow.change)}
        onCancel={() => dispatch({ type: "cancel" })}
      />
    </>
  );
}

function FlowCard(props: { flow: Flow; onRetry: () => void; onDismiss: () => void }) {
  const f = props.flow;
  if (f.phase === "idle" || f.phase === "confirming") return null;
  const what = changeCopy(f.change).confirm;
  if (f.phase === "submitting" || f.phase === "stepping")
    return (
      <Card>
        <p role="status">{f.phase === "stepping" ? "Waiting for you to confirm it's you…" : "Saving…"}</p>
      </Card>
    );
  if (f.phase === "done")
    return (
      <Card>
        <div className={v.row}>
          <p role="status">Saved: {what}. The state below changes once the next read has run.</p>
          <Button size="sm" onClick={props.onDismiss}>Dismiss</Button>
        </div>
      </Card>
    );
  return (
    <Card>
      <div className={v.row}>
        <p className={v.errLine} role="alert">
          {f.phase === "declined" ? "You didn't confirm it's you. Nothing changed." : `Nothing changed: ${f.message}`}
        </p>
        <Button size="sm" onClick={props.onRetry}>Try again</Button>
        <Button size="sm" onClick={props.onDismiss}>Dismiss</Button>
      </div>
    </Card>
  );
}

function SourceMissing() {
  return <p className={v.errLine} role="alert">This source could not be found in the sources list, so its settings cannot be changed here.</p>;
}

function M365View(props: { data: M365Setup; source: DiscoverySourceView | undefined; sourceMissing: boolean; busy: boolean; onAsk: (c: Change) => void }) {
  const a = props.data.activityLogs;
  const copy = ACTIVITY_COPY[a.state];
  return (
    <>
      <Card
        title="Activity log"
        actions={<Badge tone={copy.tone}>{copy.label}</Badge>}
        caption={<span className={v.dim}>The Entra sign-in activity log, used to judge which granted apps go unused. Off by default.</span>}
      >
        <div className={v.stack}>
          <p>{copy.detail}</p>
          <p className={v.dim}>
            Needs the {a.permissionType} permission <code>{a.permission}</code> with admin consent, and {a.license}.
          </p>
          {props.sourceMissing ? (
            <SourceMissing />
          ) : (
            <div>
              <Button size="sm" variant={a.requested ? undefined : "primary"} aria-disabled={props.busy || !props.source || undefined} onClick={() => !props.busy && props.source && props.onAsk({ kind: "activityLogs", on: !a.requested })}>
                {a.requested ? "Stop asking for the activity log" : "Ask for the activity log"}
              </Button>
            </div>
          )}
        </div>
      </Card>
      <Card title="Setup checklist" caption={<span className={v.dim}>Done by an Entra administrator, in this order. RegulAIt cannot tick these off: the state above is what the latest read observed.</span>}>
        <ol className={v.stack}>
          {a.steps.map((s) => (
            <li key={s.id}>
              <strong>{s.title}</strong>
              <p>{s.detail}</p>
              {s.id === "grant-consent" &&
                (a.consentUrl ? (
                  <p>
                    <a href={a.consentUrl} target="_blank" rel="noopener noreferrer">
                      Open the admin consent page (opens in a new tab)
                    </a>
                  </p>
                ) : (
                  <p className={v.dim}>No consent link yet: it needs the source's tenant id and a live credential with its client id.</p>
                ))}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

function SalesforceView(props: {
  data: SalesforceSetup;
  source: DiscoverySourceView | undefined;
  sourceMissing: boolean;
  settings: DiscoverySettingsView | undefined;
  settingsFailed: boolean;
  busy: boolean;
  onAsk: (c: Change) => void;
}) {
  const t = props.data.orgTokens;
  const reading = t.requested && t.allowed;
  return (
    <>
      <Card title="What the default read sees" caption={<span className={v.dim}>The least-privilege read: no broad access unless an administrator opts in below.</span>}>
        <ul className={v.stack}>{props.data.sees.map((s) => <li key={s}>{s}</li>)}</ul>
      </Card>
      <Card title="What it cannot see">
        {props.data.cannotSee.length === 0 ? <p className={v.dim}>The server listed nothing it cannot see.</p> : <ul className={v.stack}>{props.data.cannotSee.map((s) => <li key={s}>{s}</li>)}</ul>}
      </Card>
      <Card
        title="Org-wide token read"
        actions={<Badge tone={reading ? "warn" : "neutral"}>{reading ? "On for this source" : "Off"}</Badge>}
        caption={<span className={v.dim}>Lets the read see which users hold a token for each connected app. Needs {t.permission} on the integration user.</span>}
      >
        <div className={v.stack}>
          <p>{t.tradeOff}</p>
          <div className={v.row}>
            <span>Org switch: <strong>{t.allowed ? "allowed" : "not allowed"}</strong></span>
            {props.settingsFailed ? (
              <span className={v.errLine} role="alert">The discovery settings could not be loaded, so the switch cannot be changed here.</span>
            ) : (
              <Button size="sm" aria-disabled={props.busy || !props.settings || undefined} onClick={() => !props.busy && props.settings && props.onAsk({ kind: "orgSwitch", on: !t.allowed })}>
                {t.allowed ? "Stop allowing org-wide token reads" : "Allow org-wide token reads"}
              </Button>
            )}
          </div>
          <div className={v.row}>
            <span>This source: <strong>{t.requested ? "asks to read tokens" : "does not ask"}</strong></span>
            {props.sourceMissing ? (
              <SourceMissing />
            ) : (
              <>
                <Button
                  size="sm"
                  aria-describedby={!t.allowed && !t.requested ? "sf-switch-off" : undefined}
                  aria-disabled={props.busy || !props.source || (!t.allowed && !t.requested) || undefined}
                  onClick={() => !props.busy && props.source && (t.allowed || t.requested) && props.onAsk({ kind: "sourceTokens", on: !t.requested })}
                >
                  {t.requested ? "Stop reading tokens for this source" : "Read tokens for this source"}
                </Button>
                {!t.allowed && !t.requested && <span id="sf-switch-off" className={v.dim}>Allow org-wide token reads first.</span>}
              </>
            )}
          </div>
          {t.requested && !t.allowed && <p className={v.dim}>This source asks for tokens, but the org switch is off, so its reads keep the least-privilege view.</p>}
        </div>
      </Card>
    </>
  );
}

function LastReadCard({ data }: { data: ReadSetup }) {
  const r = data.lastRead;
  return (
    <Card title="Latest read">
      {r == null ? (
        <p className={v.dim}>This source has never been read.</p>
      ) : (
        <p>
          {fmtAt(r.recordedAt)}: {r.note} <span className={v.dim}>(coverage: {r.coverage === "none" ? "none" : r.coverage === "app" ? "per app" : "per permission"})</span>
        </p>
      )}
    </Card>
  );
}
