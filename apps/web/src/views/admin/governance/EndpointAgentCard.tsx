/**
 * ADR-0195 SD4b — the RegulAIt endpoint agent on the Discovery sources page:
 * issue an enrolment token for an enabled endpoint agent source (shown once,
 * as the enrolment file MDM delivers), and preview the tokens and the devices
 * that enrolled (P3: revoking them, and the full lists, are on their own pages).
 * Devices and their users appear only as pseudonyms.
 * ADR-0197 Q13: a token lives 30 days at most unless the admin confirms it is
 * them for a longer one (up to 90, audited). Q14: revoking a token stops new
 * enrolments; revoking the devices it enrolled is a separate, unchecked choice.
 */
import { useState } from "react";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Input, Select } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";
import type { DiscoverySourceView } from "./discoverySourcesModel";
import {
  DISCOVERY_SOURCES_PATH,
  ListPreview,
  deviceColumns,
  devicesAttention,
  tokenColumns,
  tokensAttention,
  type DeviceView,
  type TokenView,
} from "./discoveryLists";

/** ADR-0197 Q13: the default and strict maximum, and the most a step-up relaxation allows */
const TOKEN_DAYS = 30;
const TOKEN_RELAXED_DAYS = 90;

export function EndpointAgentCard({ sources }: { sources: readonly DiscoverySourceView[] }) {
  const act = useAction();
  const targets = sources.filter((s) => s.kind === "endpoint_agent");
  const [picked, setPicked] = useState("");
  // with one endpoint agent source there is nothing to choose: its devices show without a click
  const sourceId = picked || (targets.length === 1 ? targets[0]!.id : "");
  const [label, setLabel] = useState("");
  const [deviceCap, setDeviceCap] = useState("");
  const [days, setDays] = useState("30");
  const [enrolFile, setEnrolFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = targets.find((s) => s.id === sourceId) ?? null;

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
      // the action's own refresh reloads the token and device lists (their query keys sit under "admin")
      return `Enrolment token '${out.token.label}' issued`;
    });
  };

  return (
    <Card
      title="Endpoint agent enrolment"
      info={
        <p>
          The regulAIt endpoint agent is distributed through your MDM. Issue an enrolment token here and deliver the enrolment file to each device; the
          agent&apos;s install step redeems it once for that device, and each user of the device registers their own device key. Nothing enrols or uploads
          while the source is disabled. Devices and their users are shown only as pseudonyms; a device user&apos;s name is self-reported by the device.
        </p>
      }
    >
      <div className={v.stack}>
        {targets.length === 0 ? (
          <p className={v.faint}>Add and enable a regulAIt endpoint agent source above to enrol devices.</p>
        ) : (
          <>
            <Field label="Endpoint agent source" error={error}>
              <Select value={sourceId} onChange={(e) => { setPicked(e.target.value); setEnrolFile(null); }}>
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
                {/* P3: the newest few of each list, with what needs attention in the heading; the full lists have their own pages */}
                <ListPreview<TokenView>
                  key={`tokens-${sourceId}`}
                  title="Enrolment tokens"
                  testId="preview-enrolment-tokens"
                  endpoint={`/v1/discovery/sources/${sourceId}/enrolment-tokens`}
                  legacyKey="tokens"
                  sort={{ key: "created", dir: "desc" }}
                  queryKey={["admin", "discovery", "enrolment-tokens", sourceId]}
                  noun={["token", "tokens"]}
                  attention={tokensAttention}
                  columns={tokenColumns().filter((c) => c.main)}
                  rowKey={(t) => t.id}
                  viewAll={`${DISCOVERY_SOURCES_PATH}/tokens?source=${encodeURIComponent(sourceId)}`}
                  empty={<EmptyState title="No enrolment token" body="Issue one above to enrol devices." />}
                />
                <ListPreview<DeviceView>
                  key={`devices-${sourceId}`}
                  title="Endpoint devices"
                  testId="preview-endpoint-devices"
                  endpoint={`/v1/discovery/sources/${sourceId}/endpoint-devices`}
                  legacyKey="devices"
                  sort={{ key: "created", dir: "desc" }}
                  queryKey={["admin", "discovery", "endpoint-devices", sourceId]}
                  noun={["device", "devices"]}
                  attention={devicesAttention}
                  columns={deviceColumns().filter((c) => c.main)}
                  rowKey={(d) => d.id}
                  viewAll={`${DISCOVERY_SOURCES_PATH}/devices?source=${encodeURIComponent(sourceId)}`}
                  empty={<EmptyState title="No device has enrolled" body="Devices appear here once their install step redeems an enrolment token." />}
                />
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
