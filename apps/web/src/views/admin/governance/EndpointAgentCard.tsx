/**
 * ADR-0195 SD4b — the RegulAIt endpoint agent on the Discovery sources page:
 * issue an enrolment token for an enabled endpoint agent source (shown once,
 * as the enrolment file MDM delivers), revoke tokens, and list and revoke the
 * devices that enrolled. Devices and their users appear only as pseudonyms.
 * ADR-0197 Q13: a token lives 30 days at most unless the admin confirms it is
 * them for a longer one (up to 90, audited). Q14: revoking a token stops new
 * enrolments; revoking the devices it enrolled is a separate, unchecked choice.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, CodeBlock, ConfirmModal, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";
import type { DiscoverySourceView } from "./discoverySourcesModel";

interface TokenView {
  id: string;
  label: string;
  deviceCap: number;
  devicesEnrolled: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** ADR-0197 Q14: devices it enrolled that are not revoked (absent from a gateway before Q14) */
  devicesActive?: number;
}
interface IdentityView {
  identityId: string;
  deviceUserPseudonym: string;
  keyProtection: "hardware" | "software";
  keyProvider: string;
  status: string;
  lastReportAt: string | null;
}
interface DeviceView {
  id: string;
  devicePseudonym: string;
  os: string;
  arch: string;
  agentVersion: string;
  identitiesRegistered: number;
  identityCap: number;
  lastReportAt: string | null;
  revokedAt: string | null;
  identities: IdentityView[];
}
interface DevicesView {
  devices: DeviceView[];
  summary: { devices: number; revoked: number; softwareKeys: number };
}

const when = (iso: string | null) => <span style={{ whiteSpace: "nowrap" }}>{fmtDateTime(iso, "never")}</span>;
/** ADR-0197 Q13: the default and strict maximum, and the most a step-up relaxation allows */
const TOKEN_DAYS = 30;
const TOKEN_RELAXED_DAYS = 90;

export function EndpointAgentCard({ sources }: { sources: readonly DiscoverySourceView[] }) {
  const act = useAction();
  const targets = sources.filter((s) => s.kind === "endpoint_agent");
  const [sourceId, setSourceId] = useState("");
  const [label, setLabel] = useState("");
  const [deviceCap, setDeviceCap] = useState("");
  const [days, setDays] = useState("30");
  const [enrolFile, setEnrolFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ kind: "token"; row: TokenView } | { kind: "device"; row: DeviceView } | null>(null);
  // ADR-0197 Q14: off by default each time the dialog opens
  const [alsoDevices, setAlsoDevices] = useState(false);
  const chosen = targets.find((s) => s.id === sourceId) ?? null;

  const tokens = useQuery({
    queryKey: ["admin", "discovery", "enrolment-tokens", sourceId],
    enabled: !!chosen,
    queryFn: () => api.get<{ tokens: TokenView[] }>(`/v1/discovery/sources/${sourceId}/enrolment-tokens`),
  });
  const devices = useQuery({
    queryKey: ["admin", "discovery", "endpoint-devices", sourceId],
    enabled: !!chosen,
    queryFn: () => api.get<DevicesView>(`/v1/discovery/sources/${sourceId}/endpoint-devices`),
  });

  const issue = () => {
    if (!chosen) return setError("Choose an endpoint agent source.");
    const cap = Number(deviceCap);
    const expiresInDays = Number(days);
    if (!label.trim()) return setError("Name the token, for example the MDM group it is for.");
    if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) return setError("Set how many devices may enrol with it (1 to 100000).");
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > TOKEN_RELAXED_DAYS) return setError(`Expiry is 1 to ${TOKEN_RELAXED_DAYS} days.`);
    setError(null);
    const body = { label: label.trim(), deviceCap: cap, expiresInDays };
    void act.run(async () => {
      // past 30 days the gateway asks for a step-up (a relaxation of this token, audited); the same body is resent
      const out = await withStepUp((h) => stepUpApi.post<{ token: TokenView; enrolFile: Record<string, string> }>(`/v1/discovery/sources/${chosen.id}/enrolment-tokens`, body, h));
      setEnrolFile(JSON.stringify(out.enrolFile, null, 2));
      setLabel("");
      await tokens.refetch();
      return `Enrolment token '${out.token.label}' issued`;
    });
  };

  const confirmRevoke = () => {
    const r = revoking;
    const revokeDevices = alsoDevices;
    setRevoking(null);
    setAlsoDevices(false);
    if (!r) return;
    void act.run(async () => {
      if (r.kind === "token") {
        const out = await api.post<{ devicesRevoked?: number }>(`/v1/discovery/enrolment-tokens/${r.row.id}/revoke`, { revokeDevices });
        await tokens.refetch();
        if (revokeDevices) await devices.refetch();
        return revokeDevices ? `Enrolment token '${r.row.label}' revoked with ${out.devicesRevoked ?? 0} device(s)` : `Enrolment token '${r.row.label}' revoked`;
      }
      const out = await api.post<{ identitiesRevoked: number }>(`/v1/discovery/endpoint-devices/${r.row.id}/revoke`, {});
      await devices.refetch();
      return `Device ${r.row.devicePseudonym} revoked (${out.identitiesRevoked} agent identity(ies))`;
    });
  };

  return (
    <Card title="Endpoint agent enrolment">
      <div className={v.stack}>
        <p className={v.faint}>
          The regulAIt endpoint agent is distributed through your MDM. Issue an enrolment token here and deliver the enrolment file to each device; the
          agent&apos;s install step redeems it once for that device, and each user of the device registers their own device key. Nothing enrols or uploads
          while the source is disabled. Devices and their users are shown only as pseudonyms; a device user&apos;s name is self-reported by the device.
        </p>
        {targets.length === 0 ? (
          <p className={v.faint}>Add and enable a regulAIt endpoint agent source above to enrol devices.</p>
        ) : (
          <>
            <Field label="Endpoint agent source" error={error}>
              <Select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setEnrolFile(null); }}>
                <option value="">Choose a source</option>
                {targets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.name}${s.enabled ? "" : " (disabled)"}`}
                  </option>
                ))}
              </Select>
            </Field>
            {chosen && (
              <>
                <div className={v.row}>
                  <Field label="Token name">
                    <Input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
                  </Field>
                  <Field label="Device cap (required)">
                    <Input inputMode="numeric" value={deviceCap} onChange={(e) => setDeviceCap(e.target.value)} />
                  </Field>
                  <Field label={`Expires in (days, ${TOKEN_DAYS} by default; past ${TOKEN_DAYS}, up to ${TOKEN_RELAXED_DAYS}, asks you to confirm it's you and is audited)`}>
                    <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
                  </Field>
                </div>
                <div className={v.row}>
                  <Button variant="primary" disabled={act.busy || !chosen.enabled} onClick={issue}>Issue enrolment token</Button>
                  {!chosen.enabled && <span className={v.faint}>Enable this source first.</span>}
                </div>
                {enrolFile && (
                  <div className={v.stack} data-testid="endpoint-enrol-file">
                    <p>
                      <Badge tone="warn">shown once</Badge> Save this as the enrolment file your MDM places on each device (root-owned, mode 0600). It is
                      not shown again.
                    </p>
                    <CodeBlock>{enrolFile}</CodeBlock>
                  </div>
                )}
                <Table<TokenView>
                  rows={tokens.data?.tokens ?? []}
                  rowKey={(t) => t.id}
                  empty={<EmptyState title="No enrolment token" body="Issue one above to enrol devices." />}
                  columns={[
                    { key: "label", header: "Token", render: (t) => t.label },
                    { key: "devices", header: "Devices", render: (t) => `${t.devicesEnrolled} / ${t.deviceCap}` },
                    { key: "expires", header: "Expires", render: (t) => when(t.expiresAt) },
                    {
                      key: "state",
                      header: "State",
                      render: (t) =>
                        t.revokedAt ? (
                          <Badge tone="neutral">revoked</Badge>
                        ) : (
                          <Button size="sm" disabled={act.busy} onClick={() => setRevoking({ kind: "token", row: t })}>
                            Revoke
                          </Button>
                        ),
                    },
                  ]}
                />
                <p className={v.faint}>
                  {devices.data
                    ? `${devices.data.summary.devices} device(s), ${devices.data.summary.revoked} revoked, ${devices.data.summary.softwareKeys} agent identity(ies) with a software key (no key hardware on the device).`
                    : "Loading devices…"}
                </p>
                <Table<DeviceView>
                  rows={devices.data?.devices ?? []}
                  rowKey={(d) => d.id}
                  empty={<EmptyState title="No device has enrolled" body="Devices appear here once their install step redeems an enrolment token." />}
                  columns={[
                    { key: "device", header: "Device", render: (d) => <span className={v.mono}>{d.devicePseudonym}</span> },
                    { key: "platform", header: "Platform", render: (d) => `${d.os}/${d.arch}, agent ${d.agentVersion}` },
                    {
                      key: "users",
                      header: "Users (self-reported)",
                      render: (d) =>
                        d.identities.length === 0
                          ? "none registered"
                          : d.identities.map((i) => (
                              <div key={i.identityId}>
                                <span className={v.mono}>{i.deviceUserPseudonym}</span>{" "}
                                <Badge tone={i.keyProtection === "hardware" ? "ok" : "warn"}>{`${i.keyProtection} key`}</Badge>
                              </div>
                            )),
                    },
                    { key: "last", header: "Last report", render: (d) => when(d.lastReportAt) },
                    {
                      key: "state",
                      header: "State",
                      render: (d) =>
                        d.revokedAt ? (
                          <Badge tone="neutral">revoked</Badge>
                        ) : (
                          <Button size="sm" disabled={act.busy} onClick={() => setRevoking({ kind: "device", row: d })}>
                            Revoke
                          </Button>
                        ),
                    },
                  ]}
                />
              </>
            )}
          </>
        )}
      </div>
      <ConfirmModal
        open={revoking !== null}
        danger
        title={revoking?.kind === "device" ? "Revoke this device?" : "Revoke this enrolment token?"}
        body={
          revoking?.kind === "device" ? (
            "Its agent identities, keys and tokens are revoked and it uploads nothing more. Enrolling it again needs a new ticket."
          ) : (
            <div className={v.stackTight}>
              <p>
                It redeems no new device ticket, and its unexpired tickets register no new user.{" "}
                {alsoDevices ? "The devices it enrolled are revoked too." : "Devices already enrolled keep reporting."}
              </p>
              <label className={v.rowTight}>
                <input type="checkbox" checked={alsoDevices} onChange={(e) => setAlsoDevices(e.target.checked)} />
                <span>
                  {revoking?.kind === "token" && revoking.row.devicesActive !== undefined
                    ? `Also revoke the ${revoking.row.devicesActive} device(s) it enrolled`
                    : "Also revoke the devices it enrolled"}
                  {" "}(their agent identities, keys and tokens; they upload nothing more)
                </span>
              </label>
            </div>
          )
        }
        confirmLabel={revoking?.kind === "token" && alsoDevices ? "Revoke token and devices" : "Revoke"}
        onConfirm={confirmRevoke}
        onCancel={() => {
          setRevoking(null);
          setAlsoDevices(false);
        }}
      />
    </Card>
  );
}
