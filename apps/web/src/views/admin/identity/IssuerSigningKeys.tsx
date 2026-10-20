/**
 * ADR-0188 — two workload-identity surfaces:
 *  - the gateway issuer's signing keys (`/v1/identity/signing-keys`): list
 *    the public halves, rotate to a configured key, revoke a compromised one.
 *    Both writes are a `key_management` step-up (bound to the exact key)
 *    behind a confirmation, and
 *    audited by the gateway;
 *  - one delegation grant's detail (`GET /v1/delegation-grants/:grantId`),
 *    with its incoming allocation and every outgoing one.
 */
import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, SkeletonBlock, Table } from "../../../ui/kit";
import { getDelegationGrant, listSigningKeys, revokeSigningKey, rotateSigningKey, signingKeyKeys, workloadIdentityKeys } from "./workloadIdentityApi";
import { SIGNING_KEY_SOURCE_TEXT, SIGNING_KEY_STATE_TEXT, kidOk, signingKeyRefusal, signingKeyState, type IdentitySigningKeyView } from "./signingKeyModel";
import { formatMicros, type DelegationAllocationView } from "./workloadIdentityModel";
import s from "./workloadIdentities.module.css";
import { fmtDateTime } from "../../../api/format";

const dateLabel = (value: string | null) => fmtDateTime(value);

/** the page's confirmation (WorkloadIdentitiesPage `ask`) */
export interface AskConfirmation {
  title: string;
  body: ReactNode;
  label: string;
  danger: boolean;
  okMessage: string;
  run: () => Promise<unknown>;
}

/** a signing-key refusal in the page's words, else the client's own reading */
async function signingKeyCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof ApiError ? signingKeyRefusal(e.payload.error) : null;
    throw text ? new Error(text) : e;
  }
}

const STATE_TONE = { active: "ok", retired: "neutral", revoked: "danger", recorded: "neutral" } as const;

export function IssuerSigningKeysCard(props: { busy: boolean; ask: (c: AskConfirmation) => void }) {
  const keys = useQuery({ queryKey: signingKeyKeys.list, queryFn: listSigningKeys });
  const [kid, setKid] = useState("");
  const [kidError, setKidError] = useState<string | null>(null);
  const helpId = useId();
  return (
    <Card
      title="Issuer signing keys"
      actions={
        <Button disabled={keys.isFetching} onClick={() => void keys.refetch()}>
          Refresh keys
        </Button>
      }
    >
      <p>
        The gateway signs workload and delegated tokens with one active Ed25519 key. Only public halves are shown. A new key&apos;s private half is
        configured by the deployment operator first; rotating here activates it and retires the current signer, whose public half stays published
        until the tokens it signed expire.
      </p>
      {keys.data?.configuration && (
        // ADR-0188 S7: where the private halves come from; engine runners and PDP clients need one to authenticate
        <p>
          <Badge tone={keys.data.configuration.source === "missing" || keys.data.configuration.source === "invalid" ? "danger" : "ok"}>
            {SIGNING_KEY_SOURCE_TEXT[keys.data.configuration.source]}
          </Badge>{" "}
          {keys.data.configuration.note}
        </p>
      )}
      <form
        className={s.actions}
        onSubmit={(e) => {
          e.preventDefault();
          const value = kid.trim();
          if (value && !kidOk(value)) return setKidError("A key id is 1 to 128 letters, digits and . _ : - characters.");
          setKidError(null);
          props.ask({
            title: "Rotate the issuer signing key?",
            label: "Rotate key",
            danger: false,
            okMessage: "Signing key rotated. New tokens are signed with the new key.",
            body: (
              <>
                {value ? (
                  <>
                    Activates the configured key <code>{value}</code>
                  </>
                ) : (
                  "Activates the one configured key that has never been used"
                )}{" "}
                and retires the current signer. Tokens it already signed stay valid until they expire. Nothing is revoked.
              </>
            ),
            run: () => signingKeyCall(() => rotateSigningKey(value || null)),
          });
        }}
      >
        <Field label="Key id to activate (optional)" error={kidError}>
          <Input value={kid} maxLength={128} autoComplete="off" spellCheck={false} aria-describedby={helpId} onChange={(e) => setKid(e.target.value)} />
        </Field>
        <Button type="submit" disabled={props.busy}>
          Rotate key
        </Button>
      </form>
      <p id={helpId}>Leave the key id blank when exactly one configured key has never been used; the gateway refuses to guess between several.</p>
      {keys.isPending ? (
        <SkeletonBlock lines={3} />
      ) : keys.isError ? (
        <ErrorState message="The signing keys could not be read. No key state is inferred." onRetry={() => void keys.refetch()} />
      ) : (
        <Table<IdentitySigningKeyView>
          rows={keys.data.items}
          rowKey={(k) => k.kid}
          empty={<EmptyState title="No signing key recorded" body="No token can be issued until an operator configures a key and an admin rotates to it." />}
          columns={[
            { key: "kid", header: "Key id", render: (k) => <code title={k.kid}>{k.kid.length > 24 ? `${k.kid.slice(0, 24)}…` : k.kid}</code> },
            {
              key: "state",
              header: "State",
              render: (k) => {
                const st = signingKeyState(k);
                return (
                  <>
                    <Badge tone={STATE_TONE[st]}>{st}</Badge>
                    <div>{SIGNING_KEY_STATE_TEXT[st]}</div>
                  </>
                );
              },
            },
            { key: "created", header: "Created", render: (k) => dateLabel(k.createdAt) },
            { key: "activated", header: "Activated", render: (k) => dateLabel(k.activatedAt) },
            { key: "retired", header: "Retired", render: (k) => dateLabel(k.retiredAt) },
            { key: "revoked", header: "Revoked", render: (k) => dateLabel(k.revokedAt) },
            {
              key: "revoke",
              header: "Compromise",
              render: (k) =>
                k.revokedAt ? (
                  <span>Already revoked</span>
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={props.busy}
                    aria-label={`Revoke signing key ${k.kid}`}
                    onClick={() =>
                      props.ask({
                        title: "Revoke this signing key?",
                        label: "Revoke key",
                        danger: true,
                        okMessage: "Signing key revoked. Every token it signed is refused.",
                        body: (
                          <>
                            Every unexpired token signed with <code>{k.kid}</code> is refused from now on, and the key leaves the published JWKS. This
                            cannot be undone.
                            {signingKeyState(k) === "active" && " It is the active signer: no new token can be issued until you rotate to another configured key."}
                          </>
                        ),
                        run: () => signingKeyCall(() => revokeSigningKey(k.kid)),
                      })
                    }
                  >
                    Revoke
                  </Button>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}


function EdgeLine(props: { edge: DelegationAllocationView; label: string }) {
  const e = props.edge;
  return (
    <li>
      {props.label}: allocated {formatMicros(e.amountMicros)}, drawn {formatMicros(e.drawnMicros)}, released {formatMicros(e.releasedMicros)} ({e.status}
      {e.closedAt ? `, closed ${dateLabel(e.closedAt)}` : ""})
    </li>
  );
}

/** `GET /v1/delegation-grants/:grantId` in a dialog */
export function DelegationGrantDetail(props: { grantId: string; actorLabel: (id: string) => string; personLabel: (id: string) => string; onClose: () => void }) {
  const q = useQuery({ queryKey: [...workloadIdentityKeys.root, "grant", props.grantId], queryFn: () => getDelegationGrant(props.grantId) });
  const g = q.data;
  return (
    <Modal
      open
      title="Delegation grant"
      onClose={props.onClose}
      actions={<Button onClick={props.onClose}>Close</Button>}
    >
      {q.isPending ? (
        <SkeletonBlock lines={4} />
      ) : q.isError ? (
        <ErrorState
          message={q.error instanceof ApiError && q.error.payload.error === "grant_not_found" ? "That delegation grant no longer exists. Refresh the tree." : "The grant could not be read. Nothing is inferred."}
          onRetry={() => void q.refetch()}
        />
      ) : g ? (
        <div className={s.stack} data-testid="delegation-grant-detail">
          <dl>
            <dt>Actor</dt>
            <dd>{props.actorLabel(g.actorIdentityId)}</dd>
            <dt>Human sponsor</dt>
            <dd>{props.personLabel(g.sponsorUserId)}</dd>
            <dt>Depth</dt>
            <dd>{g.parentGrantId ? `${g.depth} (delegated)` : "Root grant"}</dd>
            <dt>Environment · audience</dt>
            <dd>
              {g.environment} · {g.audience ?? "no audience"}
            </dd>
            <dt>Budget</dt>
            <dd>
              {g.capMicros === null ? "Uncapped" : `Cap ${formatMicros(g.capMicros)}`}; spent {formatMicros(g.settledMicros)}; reserved {formatMicros(g.reservedMicros)}
            </dd>
            <dt>Expires</dt>
            <dd>{dateLabel(g.expiresAt)}</dd>
            <dt>Revoked</dt>
            <dd>{g.revokedAt ? `${dateLabel(g.revokedAt)}${g.revokedReason ? ` (${g.revokedReason})` : ""}` : "No"}</dd>
          </dl>
          <ul>
            {g.allocation ? <EdgeLine edge={g.allocation} label="From its parent" /> : <li>No incoming allocation (a root grant).</li>}
            {g.childAllocations.length === 0 ? (
              <li>No child allocations.</li>
            ) : (
              g.childAllocations.map((e) => <EdgeLine key={e.id} edge={e} label={`To child grant ${e.childGrantId.slice(0, 8)}`} />)
            )}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}
