/**
 * ADR-0195 SD0 — the active discovery rows on the Enforcement posture page:
 * sources enabled, static credentials in use, static credentials older than
 * the warning age, and credentials whose write scope is unverified. Reported,
 * never a control (it does not count toward "hardened").
 */
import { Link } from "react-router-dom";
import { Badge, Card, Table } from "../../../ui/kit";
import v from "../../views.module.css";
import ps from "../settings/posture.module.css";
import type { DiscoveryPostureView } from "./discoverySourcesModel";

interface Row {
  key: string;
  label: string;
  names: string[];
  tone: "ok" | "warn" | "danger" | "neutral";
}

export function discoveryPostureRows(p: DiscoveryPostureView): Row[] {
  return [
    { key: "enabled", label: "Sources enabled (scanned read-only)", names: p.sourcesEnabled.map((s) => s.name), tone: p.sourcesEnabled.length ? "warn" : "ok" },
    { key: "static", label: "Static credentials in use (a relaxation)", names: p.staticCredentials.map((s) => s.name), tone: p.staticCredentials.length ? "warn" : "ok" },
    {
      key: "stale",
      label: `Static credentials older than ${p.credentialWarningAgeDays} days`,
      names: p.staleCredentials.map((s) => `${s.name} (${s.ageDays} days)`),
      tone: p.staleCredentials.length ? "danger" : "ok",
    },
    { key: "write", label: "Credentials with write scope unverified", names: p.writeScopeUnverified.map((s) => s.name), tone: p.writeScopeUnverified.length ? "warn" : "ok" },
    {
      key: "refused",
      label: "Credentials refused (grant write access)",
      names: (p.credentialsRefused ?? []).map((s) => s.name),
      tone: (p.credentialsRefused ?? []).length ? "danger" : "ok",
    },
  ];
}

export function DiscoveryPostureCard(props: { posture: DiscoveryPostureView | undefined }) {
  if (!props.posture) return null;
  return (
    <Card title="Shadow-AI active discovery">
      <p data-testid="discovery-posture-statement">{props.posture.statement}</p>
      <Table<Row>
        rows={discoveryPostureRows(props.posture)}
        rowKey={(r) => r.key}
        columns={[
          { key: "label", header: "Row", render: (r) => r.label },
          { key: "count", header: "Count", render: (r) => <Badge tone={r.tone}>{String(r.names.length)}</Badge> },
          { key: "names", header: "Sources", render: (r) => <span className={v.faint}>{r.names.join(", ") || "none"}</span> },
        ]}
      />
      <p className={`${v.faint} ${ps.inlineLinks}`}>
        Manage sources on <Link to="/admin/shadow-ai/discovery-sources">Discovery sources</Link>.
      </p>
    </Card>
  );
}
