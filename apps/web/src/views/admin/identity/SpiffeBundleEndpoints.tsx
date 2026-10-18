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
import { useState } from "react";
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
  const [formError, setFormError] = useState<string | null>(null);
  const list = isEndpointList(q.data) ? q.data : null;

  const save = async (td: string, body: Parameters<typeof setSpiffeBundleEndpoint>[1]) => {
    const out = await endpointCall(() => setSpiffeBundleEndpoint(td, body));
    // a fetch may have written a new bundle: both lists are read again
    void qc.invalidateQueries({ queryKey: spiffeEndpointKeys.list });
    void qc.invalidateQueries({ queryKey: spiffeBundleKeys.list });
    if (out.refresh?.outcome === "failed") throw new Error(`Saved; the fetch failed: ${spiffeEndpointCode(out.refresh.code) ?? out.refresh.code}`);
    return out;
  };

  return (
    <Card title="SPIFFE bundle endpoints">
      <div data-testid="spiffe-bundle-endpoints">
        <p>
          Fetch a domain&apos;s bundle from its SPIFFE bundle endpoint, through the egress allow-list. Off until set. After a failed fetch the last good
          bundle is kept for 24 hours at most. Air-gapped: leave empty and upload. Saving a listed domain changes its endpoint.
        </p>
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            const td = trustDomain.trim();
            const draft = { trustDomain: td, url: url.trim(), profile, endpointSpiffeId: endpointSpiffeId.trim() };
            const problem = endpointDraftError(draft);
            setFormError(problem);
            if (problem) return;
            props.ask({
              title: `Fetch the bundle of ${td}?`,
              label: "Save and fetch",
              danger: false,
              okMessage: "Endpoint saved.",
              body: (
                <>
                  A fetched bundle replaces the active one without asking: whoever controls this endpoint decides which SVIDs of <code>{td}</code>{" "}
                  authenticate.
                </>
              ),
              run: () => save(td, { url: draft.url, profile, endpointSpiffeId: profile === "https_spiffe" ? draft.endpointSpiffeId : null, enabled: true }),
            });
          }}
        >
          <Field label="Trust domain to fetch" error={formError}>
            <Input value={trustDomain} maxLength={255} spellCheck={false} placeholder="example.org" onChange={(e) => setTrustDomain(e.target.value)} />
          </Field>
          <Field label="Bundle endpoint URL">
            <Input value={url} type="url" maxLength={2048} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Endpoint profile">
            <Select value={profile} onChange={(e) => setProfile(e.target.value as SpiffeBundleEndpointProfile)}>
              <option value="https_spiffe">https_spiffe</option>
              <option value="https_web">https_web</option>
            </Select>
          </Field>
          {profile === "https_spiffe" && (
            <Field label="Endpoint server SPIFFE ID">
              <Input value={endpointSpiffeId} maxLength={2048} spellCheck={false} onChange={(e) => setEndpointSpiffeId(e.target.value)} />
            </Field>
          )}
          <p>{SPIFFE_ENDPOINT_PROFILE_TEXT[profile]}</p>
          <Button type="submit" variant="primary" disabled={props.busy}>
            Save and fetch
          </Button>
        </form>
        {q.isPending ? (
          <SkeletonBlock lines={2} />
        ) : !list ? (
          <ErrorState message="The SPIFFE bundle endpoints could not be read." onRetry={() => void q.refetch()} />
        ) : (
          <Table<SpiffeBundleEndpointView>
            rows={list.items}
            rowKey={(x) => x.trustDomain}
            empty={<EmptyState title="No bundle endpoint" />}
            columns={[
              { key: "domain", header: "Trust domain", render: (x) => <code>{x.trustDomain}</code> },
              { key: "source", header: "Endpoint", render: (x) => `${x.url} (${x.profile}${x.endpointSpiffeId ? `, ${x.endpointSpiffeId}` : ""})` },
              {
                key: "state",
                header: "State",
                render: (x) => (
                  <>
                    <Badge tone={!x.enabled ? "neutral" : x.lastErrorCode ? "warn" : "ok"}>{!x.enabled ? "off" : x.lastErrorCode ? "failing" : "fetching"}</Badge>
                    {x.lastErrorCode && <div>{spiffeEndpointCode(x.lastErrorCode) ?? x.lastErrorCode}</div>}
                  </>
                ),
              },
              { key: "until", header: "Trusted until", render: (x) => dateLabel(x.trustUntil) },
              {
                key: "actions",
                header: "Actions",
                render: (x) =>
                  x.enabled && (
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
                          body: <>The last fetched bundle keeps authenticating until {dateLabel(x.trustUntil)}.</>,
                          run: () => save(x.trustDomain, { url: x.url, profile: x.profile, endpointSpiffeId: x.endpointSpiffeId, enabled: false }),
                        })
                      }
                    >
                      Stop fetching
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
