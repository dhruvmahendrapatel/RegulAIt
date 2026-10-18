/**
 * ADR-0188 S9 — the SPIFFE trust bundles card on the workload identities page
 * (`/v1/identity/spiffe-trust-bundles`): list every bundle ever recorded,
 * upload a trust domain's first bundle or replace its active one, and revoke
 * it. Every write is an `identity_manage` step-up behind a confirmation, and
 * audited by the gateway. SPIFFE client authentication is off until a bundle
 * is uploaded (the strict default); nothing is ever fetched from a SPIRE
 * server, so this works air-gapped.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import type { AskConfirmation } from "./IssuerSigningKeys";
import { listSpiffeTrustBundles, revokeSpiffeTrustBundle, spiffeBundleKeys, uploadSpiffeTrustBundle } from "./workloadIdentityApi";
import {
  bundleDraftError,
  earliestAuthorityExpiry,
  isBundleList,
  SPIFFE_BUNDLE_STATUS_TEXT,
  spiffeBundleRefusal,
  type SpiffeTrustBundleView,
} from "./spiffeBundleModel";
import s from "./workloadIdentities.module.css";

export const dateLabel = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "—");
const STATUS_TONE = { active: "ok", superseded: "neutral", revoked: "danger" } as const;

/** a bundle refusal in the page's words, else the client's own reading */
async function bundleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof ApiError ? spiffeBundleRefusal(e.payload.error) : null;
    throw text ? new Error(text) : e;
  }
}

export function SpiffeTrustBundlesCard(props: { busy: boolean; ask: (c: AskConfirmation) => void }) {
  const q = useQuery({ queryKey: spiffeBundleKeys.list, queryFn: listSpiffeTrustBundles });
  const [trustDomain, setTrustDomain] = useState("");
  const [bundle, setBundle] = useState("");
  /** the active bundle a replacement names (compare-and-set); null for a domain's first bundle */
  const [replaces, setReplaces] = useState<SpiffeTrustBundleView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const helpId = useId();
  const list = isBundleList(q.data) ? q.data : null;
  const active = (td: string) => list?.items.find((b) => b.trustDomain === td && b.status === "active") ?? null;

  const startReplace = (b: SpiffeTrustBundleView) => {
    setTrustDomain(b.trustDomain);
    setReplaces(b);
    setBundle("");
    setFormError(null);
  };

  return (
    <Card
      title="SPIFFE trust bundles"
      actions={
        <Button disabled={q.isFetching} onClick={() => void q.refetch()}>
          Refresh bundles
        </Button>
      }
    >
      <div data-testid="spiffe-trust-bundles">
        <p>
          SPIFFE sign-in is off until a domain&apos;s bundle is here and the SPIFFE ID is bound to an identity. Paste{" "}
          <code>spire-server bundle show -format spiffe</code> (or <code>-format pem</code>) output: public keys and CA certificates only.
        </p>
        {list?.legacyEnvironmentIgnored && (
          <p role="note">
            <Badge tone="warn">Ignored</Badge> <code>REGULAIT_SPIFFE_TRUST_BUNDLES</code> is set but not read: upload bundles here, then remove it.
          </p>
        )}
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            const td = trustDomain.trim();
            const problem = bundleDraftError({ trustDomain: td, bundle });
            if (problem) return setFormError(problem);
            const current = active(td);
            // a replacement must name the bundle that is active NOW; a first upload names none
            if (current && replaces?.id !== current.id) return setFormError(`${td} already has an active bundle. Use "Replace" on its row.`);
            if (!current && replaces) return setFormError(`${td} has no active bundle any more. Refresh the list.`);
            setFormError(null);
            const body = { trustDomain: td, bundle, replacesBundleId: current?.id ?? null };
            props.ask({
              title: current ? `Replace the bundle of ${td}?` : `Trust ${td}?`,
              label: current ? "Replace bundle" : "Upload bundle",
              danger: false,
              okMessage: current ? "Bundle replaced. Tokens already issued live to their own expiry." : "Bundle uploaded. SVIDs of this domain can now authenticate.",
              body: current ? (
                <>
                  The new certificates become the only trust anchors of <code>{td}</code>. Nothing is revoked, but an SVID signed by a CA that is no longer in
                  the bundle stops authenticating, including at its next use of a certificate-bound token. Keep the old CA in the bundle until every
                  workload has a new SVID.
                </>
              ) : (
                <>
                  X.509-SVIDs signed by these CA certificates will authenticate any registered SPIFFE ID credential in <code>{td}</code>. This widens who can
                  sign in, so it needs your confirmation.
                </>
              ),
              run: async () => {
                await bundleCall(() => uploadSpiffeTrustBundle(body));
                setBundle("");
                setReplaces(null);
              },
            });
          }}
        >
          <Field label="Trust domain" error={formError}>
            <Input
              value={trustDomain}
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              placeholder="example.org"
              aria-describedby={helpId}
              readOnly={replaces !== null}
              onChange={(e) => setTrustDomain(e.target.value)}
            />
          </Field>
          <Field label="Bundle (SPIFFE JSON or PEM CA certificates)">
            <Textarea rows={6} value={bundle} spellCheck={false} onChange={(e) => setBundle(e.target.value)} />
          </Field>
          <p id={helpId}>
            The trust domain is the part after <code>spiffe://</code>, for example <code>example.org</code>.
            {replaces && <> Replacing the active bundle uploaded {dateLabel(replaces.createdAt)}.</>}
          </p>
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={props.busy}>
              {replaces ? "Replace bundle" : "Upload bundle"}
            </Button>
            {replaces && (
              <Button
                type="button"
                onClick={() => {
                  setReplaces(null);
                  setTrustDomain("");
                  setBundle("");
                  setFormError(null);
                }}
              >
                Cancel replacement
              </Button>
            )}
          </div>
        </form>
        {q.isPending ? (
          <SkeletonBlock lines={3} />
        ) : !list ? (
          <ErrorState message="The SPIFFE trust bundles could not be read. No trust state is inferred." onRetry={() => void q.refetch()} />
        ) : (
          <Table<SpiffeTrustBundleView>
            rows={list.items}
            rowKey={(b) => b.id}
            empty={<EmptyState title="No SPIFFE trust bundle" body="SPIFFE client authentication is off. Upload a trust domain's bundle to turn it on for that domain." />}
            columns={[
              { key: "domain", header: "Trust domain", render: (b) => <code>{b.trustDomain}</code> },
              {
                key: "status",
                header: "State",
                render: (b) => (
                  <>
                    <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
                    <div>{SPIFFE_BUNDLE_STATUS_TEXT[b.status]}</div>
                  </>
                ),
              },
              {
                key: "authorities",
                header: "CA certificates",
                render: (b) => (
                  <>
                    {b.authorities.length} (earliest expiry {dateLabel(earliestAuthorityExpiry(b))})
                    {(b.jwtAuthorities?.length ?? 0) > 0 && <div>{b.jwtAuthorities.length} JWT-SVID key(s)</div>}
                  </>
                ),
              },
              { key: "digest", header: "Digest", render: (b) => <code title={b.digest}>{b.digest.slice(0, 12)}…</code> },
              { key: "created", header: "Added", render: (b) => <>{dateLabel(b.createdAt)}{b.source === "fetch" && <div>fetched</div>}</> },
              {
                key: "actions",
                header: "Actions",
                render: (b) =>
                  b.status !== "active" ? (
                    <span>{b.status === "revoked" ? `Revoked ${dateLabel(b.revokedAt)}` : `Replaced ${dateLabel(b.supersededAt)}`}</span>
                  ) : (
                    <div className={s.actions}>
                      <Button size="sm" disabled={props.busy} aria-label={`Replace the bundle of ${b.trustDomain}`} onClick={() => startReplace(b)}>
                        Replace
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={props.busy}
                        aria-label={`Revoke the bundle of ${b.trustDomain}`}
                        onClick={() =>
                          props.ask({
                            title: `Revoke the bundle of ${b.trustDomain}?`,
                            label: "Revoke bundle",
                            danger: true,
                            okMessage: "Bundle revoked. The domain's tokens and grants were ended.",
                            body: (
                              <>
                                No X.509-SVID of <code>{b.trustDomain}</code> authenticates until a new bundle is uploaded. Every unexpired token a SPIFFE ID of
                                this domain authenticated is revoked now, and every delegation grant they authenticated is revoked with its descendants. This
                                cannot be undone.
                              </>
                            ),
                            run: () => bundleCall(() => revokeSpiffeTrustBundle(b.id)),
                          })
                        }
                      >
                        Revoke
                      </Button>
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
