/**
 * ADR-0195 SD2b: the cloud federation issuer, on the Discovery sources page. Federated cloud credentials (AWS,
 * GCP, Entra) present a short-lived RS256 token from this issuer. Off until an admin turns it on:
 *  - Generate key: a pending key (free; it signs nothing). Its public half is published at once so the clouds can
 *    cache it before it signs.
 *  - Turn on (first activation) asks you to confirm it's you (`settings_relax`); Rotate to a pending key and Revoke a
 *    key ask too (`key_management`, bound to that key). Turn off is free.
 * The gateway decides which confirmation each act needs; this page only wraps the calls in withStepUp.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, Table } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";

export interface FederationKeyView {
  kid: string;
  algorithm: "RS256";
  state: "pending" | "active" | "retired" | "revoked";
  published: boolean;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}
export interface FederationStatusView {
  enabled: boolean;
  issuer: string | null;
  jwksUri: string | null;
  tokenTtlSeconds: number;
  keys: FederationKeyView[];
  awsPrincipal: { configured: boolean; roleArn: string | null; subject: string };
  subjectFormat: string;
  audiences: { aws: string; azure: string; gcp: string };
}

const STATE_TONE = { pending: "neutral", active: "ok", retired: "info", revoked: "danger" } as const;
const when = (iso: string | null) => <span style={{ whiteSpace: "nowrap" }}>{fmtDateTime(iso)}</span>;

export default function FederationCard() {
  const act = useAction();
  const status = useQuery({ queryKey: ["admin", "discovery", "federation"], queryFn: () => api.get<FederationStatusView>("/v1/discovery/federation") });
  const s = status.data;
  const pending = s?.keys.find((k) => k.state === "pending") ?? null;
  const refetch = async () => {
    await status.refetch();
  };

  const generate = () =>
    void act.run(async () => {
      await api.post("/v1/discovery/federation/keys", {});
      await refetch();
    }, "Federation key generated (pending)");
  const activate = (k: FederationKeyView) =>
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`/v1/discovery/federation/keys/${encodeURIComponent(k.kid)}/activate`, {}, h));
      await refetch();
    }, s?.enabled ? "Federation key rotated" : "Federation turned on");
  const revoke = (k: FederationKeyView) => {
    if (!window.confirm(`Revoke federation key ${k.kid.slice(0, 12)}…? It leaves the published key set at once.`)) return;
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`/v1/discovery/federation/keys/${encodeURIComponent(k.kid)}/revoke`, {}, h));
      await refetch();
    }, "Federation key revoked");
  };
  const turnOff = () => {
    if (!window.confirm("Turn federation off? Federated cloud sources cannot run until it is turned on again.")) return;
    void act.run(async () => {
      await api.post("/v1/discovery/federation/disable", {});
      await refetch();
    }, "Federation turned off");
  };

  return (
    <Card
      title="Cloud federation"
      actions={
        <>
          <Button disabled={act.busy || !s || pending !== null} onClick={generate}>Generate key</Button>
          {s?.enabled && <Button disabled={act.busy} onClick={turnOff}>Turn off</Button>}
        </>
      }
    >
      <div className={v.stack}>
        <p data-testid="federation-status">
          {s?.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="neutral">off</Badge>}{" "}
          Federated AWS, GCP and Entra credentials present a {s?.tokenTtlSeconds ?? 300}-second RS256 token from this issuer.{" "}
          {s?.enabled
            ? "Federation is on, so federated cloud sources can run. Rotating to a new key or revoking a key asks you to confirm it's you; turning federation off does not."
            : "Turning it on lets federated cloud sources run, and asks you to confirm it's you."}
        </p>
        <p className={v.faint}>
          Generated keys are published at once so the clouds can cache them. {s?.enabled ? "Rotate" : "Activate"} after a few minutes.
        </p>
        {s && !s.issuer && (
          <p className={v.faint} data-testid="federation-no-public-url">
            This deployment&apos;s public URL is not configured, so no token can be minted. An operator sets it as described in
            the cloud discovery deployment guide.
          </p>
        )}
        {s?.issuer && (
          <p className={v.faint}>
            Issuer <span className={v.mono}>{s.issuer}</span>, keys at <span className={v.mono}>{s.jwksUri}</span>. Subject{" "}
            <span className={v.mono}>{s.subjectFormat}</span>; audiences: AWS <span className={v.mono}>{s.audiences.aws}</span>, Entra{" "}
            <span className={v.mono}>{s.audiences.azure}</span>, GCP <span className={v.mono}>{s.audiences.gcp}</span>.
          </p>
        )}
        {s && (
          <p className={v.faint}>
            {s.awsPrincipal.configured
              ? <>regulAIt&apos;s own AWS principal is <span className={v.mono}>{s.awsPrincipal.roleArn}</span> (subject <span className={v.mono}>{s.awsPrincipal.subject}</span>); an AWS source with target <span className={v.mono}>federation=principal</span> assumes your role from it with the source&apos;s external id.</>
              : "regulAIt's own AWS principal is not configured, so each AWS source assumes your role directly with a short-lived token from this issuer."}
          </p>
        )}
        <Table
          rows={s?.keys}
          loading={status.isPending}
          rowKey={(k) => k.kid}
          empty="No federation key yet. Generate one, then turn federation on."
          columns={[
            { key: "kid", header: "Key", render: (k) => <span className={v.mono}>{k.kid.slice(0, 16)}…</span> },
            { key: "state", header: "State", render: (k) => <><Badge tone={STATE_TONE[k.state]}>{k.state}</Badge>{k.published && <div className={v.faint}>published</div>}</> },
            { key: "created", header: "Created", render: (k) => when(k.createdAt) },
            { key: "activated", header: "Activated", render: (k) => when(k.activatedAt) },
            {
              key: "actions",
              header: "",
              render: (k) => (
                <>
                  {k.state === "pending" && <Button disabled={act.busy} onClick={() => activate(k)}>{s?.enabled ? "Rotate to this key" : "Turn on with this key"}</Button>}
                  {k.state !== "revoked" && <Button disabled={act.busy} onClick={() => revoke(k)}>Revoke</Button>}
                </>
              ),
            },
          ]}
        />
      </div>
    </Card>
  );
}
