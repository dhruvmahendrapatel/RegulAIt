/**
 * ADR-0223 amendment 1 — a drift monitor's write-only ingestion credentials, inside the monitor's results card.
 *
 *  - Lists the monitor's credentials and their state (active / revoked / expired); a secret is never shown here.
 *  - Issuing and rotating show the new token ONCE, with the route and the headers a pipeline sends; the token is held
 *    in component state only until the admin dismisses it, and is never written to storage.
 *  - Issue, rotate and revoke each need an identity_manage step-up, asked for by the server (withStepUp).
 *  - Issue and rotate need the drift feature on; revoke works either way.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, EmptyState, Field, Input, RowActions, SkeletonBlock, Table, type Tone } from "../../../ui/kit";
import { RemoveButton, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export interface IngestCredential {
  id: string;
  monitorId: string;
  name: string;
  state: "active" | "revoked" | "expired";
  expiresAt: string;
  replacesId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface ListResponse {
  credentials: IngestCredential[];
  ingestRoute: string;
}
interface IssuedResponse {
  credential: IngestCredential;
  token: string;
  ingestRoute: string;
}

const STATE_TONE: Record<IngestCredential["state"], Tone> = {
  active: "ok",
  revoked: "neutral",
  expired: "warn",
};
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

export default function DriftIngestCredentials(props: { monitorId: string; monitorName: string; enabled: boolean }) {
  const path = `/v1/model-drift/monitors/${props.monitorId}/ingest-credentials`;
  const key = ["admin", "model-drift", "ingest-credentials", props.monitorId] as const;
  const list = useQuery({ queryKey: key, queryFn: () => api.get<ListResponse>(path) });
  const act = useAction();
  const [name, setName] = useState("");
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [shown, setShown] = useState<IssuedResponse | null>(null);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
  const refresh = () => void list.refetch();

  return (
    <Card title={`Ingestion credentials — ${props.monitorName}`}>
      <div className={v.stack}>
        <p className={v.faint}>
          A pipeline pushes summaries to this monitor with its own write-only credential, never an admin key. A credential opens only this
          monitor's push route, always expires, and is revoked at once. Issuing, rotating and revoking each need a step-up.
        </p>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        {shown && (
          <div className={v.stack} role="status">
            <p>
              <strong>Copy this token now; it is not shown again.</strong>
            </p>
            <Input readOnly aria-label="New ingestion token" value={shown.token} onFocus={(e) => e.currentTarget.select()} />
            <p className={v.faint}>
              Send each summary as POST {shown.ingestRoute} with the header Authorization: Bearer &lt;token&gt; and a new Idempotency-Key
              (16–128 characters) per summary. It expires {new Date(shown.credential.expiresAt).toLocaleDateString()}.
            </p>
            <div>
              <Button size="sm" onClick={() => setShown(null)}>
                I have copied it
              </Button>
            </div>
          </div>
        )}
        {list.isLoading ? (
          <SkeletonBlock />
        ) : (
          <Table
            rows={list.data?.credentials ?? []}
            rowKey={(c) => c.id}
            empty={<EmptyState title="No ingestion credentials" body="Issue one below for the pipeline that pushes this monitor's summaries." />}
            columns={[
              { key: "name", header: "Name", render: (c) => c.name, sort: (c) => c.name },
              { key: "state", header: "State", render: (c) => <Badge tone={STATE_TONE[c.state]}>{c.state}</Badge> },
              { key: "expires", header: "Expires", render: (c) => new Date(c.expiresAt).toLocaleDateString() },
              { key: "used", header: "Last used", render: (c) => (c.lastUsedAt ? ago(c.lastUsedAt) : <span className={v.faint}>Never</span>) },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (c) =>
                  c.state === "active" ? (
                    <RowActions
                      slot="10rem"
                      primary={
                        props.enabled ? (
                          <Button
                            size="sm"
                            aria-label={`Rotate ${c.name}`}
                            aria-disabled={act.busy}
                            onClick={() => {
                              if (act.busy) return;
                              void act.run(async () => {
                                const out = await withStepUp((h) =>
                                  stepUpApi.post<IssuedResponse>(`${path}/${c.id}/rotate`, { expiresInDays: DEFAULT_DAYS }, h),
                                );
                                setShown(out);
                                refresh();
                              }, "Credential rotated; the old token no longer works");
                            }}
                          >
                            Rotate
                          </Button>
                        ) : undefined
                      }
                      rest={
                        <RemoveButton
                          what={`ingestion credential ${c.name}`}
                          label="Revoke"
                          consequence="The pipeline using it is refused from its next request."
                          onRemove={() => withStepUp((h) => stepUpApi.del(`/v1/model-drift/monitors/${props.monitorId}/ingest-credentials/${c.id}`, undefined, h))}
                          onDone={refresh}
                        />
                      }
                    />
                  ) : null,
              },
            ]}
          />
        )}
        {props.enabled ? (
          <fieldset className={v.stack}>
            <legend>Issue a credential</legend>
            <div className={a.formRow}>
              <Field label="Name">
                <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="nightly scoring pipeline" />
              </Field>
              <Field label={`Expires after (days, 1–${MAX_DAYS})`}>
                <Input type="number" min={1} max={MAX_DAYS} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              </Field>
            </div>
            <div>
              <Button
                aria-disabled={act.busy || name.trim() === "" || !daysValid}
                onClick={() => {
                  if (act.busy || name.trim() === "" || !daysValid) return;
                  void act.run(async () => {
                    const out = await withStepUp((h) => stepUpApi.post<IssuedResponse>(path, { name: name.trim(), expiresInDays: days }, h));
                    setShown(out);
                    setName("");
                    refresh();
                  }, "Credential issued");
                }}
              >
                Issue credential
              </Button>
            </div>
          </fieldset>
        ) : (
          <p className={v.faint}>Turn drift monitoring on to issue or rotate a credential. Revoking works while it is off.</p>
        )}
      </div>
    </Card>
  );
}
