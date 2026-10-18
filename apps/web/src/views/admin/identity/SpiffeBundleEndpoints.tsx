/**
 * ADR-0188 S9 follow-up — the SPIFFE bundle endpoints card on the workload
 * identities page (`/v1/identity/spiffe-bundle-endpoints`): where a trust
 * domain's bundle is fetched from (SPIFFE Federation `https_web` or
 * `https_spiffe`), and how the last fetch went. Off by default: no domain is
 * fetched until an admin sets its endpoint here. Every change is an
 * `identity_manage` step-up behind a confirmation, audited by the gateway; the
 * fetch itself goes through the egress allow-list. Air-gapped installs leave
 * this empty and upload bundles instead.
 */
import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, SkeletonBlock, Table } from "../../../ui/kit";
import type { AskConfirmation } from "./IssuerSigningKeys";
import { listSpiffeBundleEndpoints, setSpiffeBundleEndpoint, spiffeBundleKeys, spiffeEndpointKeys } from "./workloadIdentityApi";
import {
  endpointDraftError,
  isEndpointList,
  SPIFFE_ENDPOINT_PROFILE_TEXT,
  spiffeEndpointCode,
  type SpiffeBundleEndpointProfile,
  type SpiffeBundleEndpointView,
} from "./spiffeBundleModel";
import s from "./workloadIdentities.module.css";

const dateLabel = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "—");

/** an endpoint refusal in the page's words, else the client's own reading */
async function endpointCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof ApiError ? spiffeEndpointCode(e.payload.error ?? e.payload.code) : null;
    throw text ? new Error(text) : e;
  }
}

export function SpiffeBundleEndpointsCard(props: { busy: boolean; ask: (c: AskConfirmation) => void }) {
  const q = useQuery({ queryKey: spiffeEndpointKeys.list, queryFn: listSpiffeBundleEndpoints });
  const qc = useQueryClient();
  const [trustDomain, setTrustDomain] = useState("");
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState<SpiffeBundleEndpointProfile>("https_spiffe");
  const [endpointSpiffeId, setEndpointSpiffeId] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const helpId = useId();
  const list = isEndpointList(q.data) ? q.data : null;

  const reset = () => {
    setEditing(null);
    setTrustDomain("");
    setUrl("");
    setProfile("https_spiffe");
    setEndpointSpiffeId("");
    setFormError(null);
  };
  const startEdit = (e: SpiffeBundleEndpointView) => {
    setEditing(e.trustDomain);
    setTrustDomain(e.trustDomain);
    setUrl(e.url);
    setProfile(e.profile);
    setEndpointSpiffeId(e.endpointSpiffeId ?? "");
    setFormError(null);
  };
  const save = async (td: string, body: Parameters<typeof setSpiffeBundleEndpoint>[1]) => {
    const out = await endpointCall(() => setSpiffeBundleEndpoint(td, body));
    // a fetch may have written a new bundle: both lists are read again
    void qc.invalidateQueries({ queryKey: spiffeEndpointKeys.list });
    void qc.invalidateQueries({ queryKey: spiffeBundleKeys.list });
    // the endpoint was saved; a first fetch that failed is said in the page's words (the row shows it too)
    if (out.refresh?.outcome === "failed") throw new Error(`Saved, but the first fetch failed: ${spiffeEndpointCode(out.refresh.code) ?? out.refresh.code ?? "unknown"}`);
    return out;
  };

  return (
    <Card
      title="SPIFFE bundle endpoints"
      actions={
        <Button disabled={q.isFetching} onClick={() => void q.refetch()}>
          Refresh endpoints
        </Button>
      }
    >
      <div data-testid="spiffe-bundle-endpoints">
        <p>
          Instead of uploading a trust domain&apos;s bundle by hand, the gateway can fetch it from the domain&apos;s SPIFFE bundle endpoint and keep it current
          (on the bundle&apos;s refresh hint). Nothing is fetched until you set an endpoint here, and every fetch goes through the egress allow-list. If a fetch
          fails, the last good bundle is kept for at most 24 hours, then the domain stops authenticating until a fetch succeeds. Air-gapped deployments leave
          this empty and upload bundles above.
        </p>
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            const td = trustDomain.trim();
            const draft = { trustDomain: td, url: url.trim(), profile, endpointSpiffeId: endpointSpiffeId.trim() };
            const problem = endpointDraftError(draft);
            if (problem) return setFormError(problem);
            const existing = list?.items.find((x) => x.trustDomain === td) ?? null;
            if (existing && editing !== td) return setFormError(`${td} already has an endpoint. Use "Edit" on its row.`);
            setFormError(null);
            props.ask({
              title: existing ? `Change where ${td} is fetched from?` : `Fetch the bundle of ${td}?`,
              label: "Save and fetch",
              danger: false,
              okMessage: "Endpoint saved. The bundle was fetched and will be kept current.",
              body: (
                <>
                  The gateway will fetch the trust bundle of <code>{td}</code> from <code>{draft.url}</code> ({SPIFFE_ENDPOINT_PROFILE_TEXT[profile]}) now and on
                  its refresh hint. A changed bundle replaces the domain&apos;s active bundle without asking again, so whoever controls this endpoint decides
                  which SVIDs of <code>{td}</code> authenticate.
                </>
              ),
              run: async () => {
                await save(td, { url: draft.url, profile, endpointSpiffeId: profile === "https_spiffe" ? draft.endpointSpiffeId : null, enabled: true });
                reset();
              },
            });
          }}
        >
          <Field label="Trust domain to fetch" error={formError}>
            <Input
              value={trustDomain}
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              placeholder="example.org"
              aria-describedby={helpId}
              readOnly={editing !== null}
              onChange={(e) => setTrustDomain(e.target.value)}
            />
          </Field>
          <Field label="Bundle endpoint URL">
            <Input value={url} type="url" maxLength={2048} autoComplete="off" spellCheck={false} placeholder="https://bundle.example.org/example.org" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Endpoint profile">
            <Select value={profile} onChange={(e) => setProfile(e.target.value as SpiffeBundleEndpointProfile)}>
              <option value="https_spiffe">SPIFFE authentication (https_spiffe)</option>
              <option value="https_web">Web PKI (https_web)</option>
            </Select>
          </Field>
          {profile === "https_spiffe" && (
            <Field label="Endpoint server SPIFFE ID">
              <Input
                value={endpointSpiffeId}
                maxLength={2048}
                autoComplete="off"
                spellCheck={false}
                placeholder="spiffe://example.org/spire/server"
                onChange={(e) => setEndpointSpiffeId(e.target.value)}
              />
            </Field>
          )}
          <p id={helpId}>
            {SPIFFE_ENDPOINT_PROFILE_TEXT[profile]}
            {profile === "https_spiffe" && <> The endpoint ID&apos;s trust domain needs an active bundle first: upload it once above to bootstrap.</>}
          </p>
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={props.busy}>
              Save and fetch
            </Button>
            {editing && (
              <Button type="button" onClick={reset}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>
        {q.isPending ? (
          <SkeletonBlock lines={2} />
        ) : !list ? (
          <ErrorState message="The SPIFFE bundle endpoints could not be read. No fetch state is inferred." onRetry={() => void q.refetch()} />
        ) : (
          <Table<SpiffeBundleEndpointView>
            rows={list.items}
            rowKey={(x) => x.trustDomain}
            empty={<EmptyState title="No bundle endpoint" body="No trust domain's bundle is fetched. Bundles come only from uploads." />}
            columns={[
              { key: "domain", header: "Trust domain", render: (x) => <code>{x.trustDomain}</code> },
              {
                key: "source",
                header: "Endpoint",
                render: (x) => (
                  <>
                    <code>{x.url}</code>
                    <div>{x.profile === "https_spiffe" ? <>https_spiffe, server {x.endpointSpiffeId}</> : "https_web"}</div>
                  </>
                ),
              },
              {
                key: "state",
                header: "State",
                render: (x) => (
                  <>
                    <Badge tone={!x.enabled ? "neutral" : x.lastErrorCode ? "warn" : "ok"}>{!x.enabled ? "off" : x.lastErrorCode ? "failing" : "fetching"}</Badge>
                    {x.lastErrorCode && (
                      <div>
                        {spiffeEndpointCode(x.lastErrorCode) ?? x.lastErrorCode} ({x.consecutiveFailures} in a row)
                      </div>
                    )}
                  </>
                ),
              },
              { key: "success", header: "Last good fetch", render: (x) => dateLabel(x.lastSuccessAt) },
              { key: "until", header: "Trusted until", render: (x) => dateLabel(x.trustUntil) },
              {
                key: "actions",
                header: "Actions",
                render: (x) => (
                  <div className={s.actions}>
                    <Button size="sm" disabled={props.busy} aria-label={`Edit the endpoint of ${x.trustDomain}`} onClick={() => startEdit(x)}>
                      Edit
                    </Button>
                    {x.enabled && (
                      <Button
                        size="sm"
                        disabled={props.busy}
                        aria-label={`Stop fetching the bundle of ${x.trustDomain}`}
                        onClick={() =>
                          props.ask({
                            title: `Stop fetching the bundle of ${x.trustDomain}?`,
                            label: "Stop fetching",
                            danger: false,
                            okMessage: "Fetching stopped.",
                            body: (
                              <>
                                The bundle of <code>{x.trustDomain}</code> is no longer fetched. Its last fetched bundle keeps authenticating until{" "}
                                {dateLabel(x.trustUntil)}, then the domain stops authenticating unless you upload a bundle or fetch again.
                              </>
                            ),
                            run: () => save(x.trustDomain, { url: x.url, profile: x.profile, endpointSpiffeId: x.endpointSpiffeId, enabled: false }),
                          })
                        }
                      >
                        Stop fetching
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
