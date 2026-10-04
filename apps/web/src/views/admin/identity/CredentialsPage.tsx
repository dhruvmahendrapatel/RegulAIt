/**
 * Credentials (ADR-0175 A7) — the non-human credential inventory.
 *
 * One read-only view over every credential the deployment stores: API and
 * virtual keys, SCIM tokens, provider keys, connector and integration
 * secrets, deploy-target credentials and roles, signing secrets. Per row:
 * owner or creator, scope, created, last used, expiry, age since the secret
 * was last set, linked agents and projects, and flags (never expires, past
 * expiry, unused, owner deactivated, over-scoped).
 *
 * Secret material is never on this page: the endpoint returns metadata only.
 * Where nothing records a last use, or an expiry is held by a third party,
 * the page says so instead of showing a blank that reads as "never".
 *
 * The `stale_credentials` monitor rule is observe-only by default (the flags
 * stay here); the toggle at the top turns on one alert episode per credential
 * type and flag, and says beforehand how many would raise now.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import v from "../../views.module.css";

type Flag = "never_expires" | "past_expiry" | "unused" | "owner_deactivated" | "over_scoped";

interface CredentialRow {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  manageAt: string;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerKind: "owner" | "creator" | null;
  ownerDisabled: boolean;
  scope: string;
  status: "active" | "revoked" | "disabled";
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedSignal: "recorded" | "ledger" | "none";
  expiresAt: string | null;
  expirySignal: "recorded" | "not_tracked";
  secretSetAt: string | null;
  rotationSignal: "recorded" | "since_created";
  ageSinceRotationDays: number;
  linkedAgents: Array<{ id: string; name: string }>;
  linkedProjects: Array<{ id: string; name: string }>;
  flags: Flag[];
  flagReasons: Partial<Record<Flag, string>>;
}

export interface CredentialInventory {
  generatedAt: string;
  unusedDays: number;
  alerting: boolean;
  linkWindowDays: number;
  ledgerWindowDays?: number;
  types: Array<{
    type: string;
    label: string;
    manageAt: string;
    lastUsed: "recorded" | "ledger" | "none";
    lastUsedNote: string;
    overScoped: string | null;
    count: number;
  }>;
  notStored: Array<{ what: string; why: string }>;
  flagLabels: Record<Flag, string>;
  counts: { total: number; flagged: number; byFlag: Record<Flag, number> };
  /** what turning alerts on would raise from this inventory now */
  alertPreview?: { episodes: number; credentials: number };
  /** the filtered list's size and this page's place in it */
  page: { total: number; limit: number; offset: number };
  credentials: CredentialRow[];
}

const FLAG_TONE: Record<Flag, Tone> = {
  never_expires: "warn",
  past_expiry: "danger",
  unused: "warn",
  owner_deactivated: "danger",
  over_scoped: "warn",
};
const ALL = "__all__";
/** rows per page; the server filters and pages (max 500) */
const PAGE_SIZE = 100;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export default function CredentialsPage() {
  const [type, setType] = useState(ALL);
  const [flag, setFlag] = useState(ALL);
  const [offset, setOffset] = useState(0);
  const search = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (type !== ALL) p.set("type", type);
    if (flag !== ALL) p.set("flag", flag);
    return p.toString();
  }, [type, flag, offset]);
  const q = useQuery({
    queryKey: ["admin", "credentials", search],
    queryFn: () => api.get<CredentialInventory>(`/v1/admin/credentials?${search}`),
    // keep the last page on screen while the next one loads
    placeholderData: (prev) => prev,
  });
  const inv = q.data;
  const rows = inv?.credentials ?? [];
  const page = inv?.page ?? { total: rows.length, limit: PAGE_SIZE, offset };
  const noSignal = (inv?.types ?? []).filter((t) => t.lastUsed === "none");

  return (
    <>
      <PageHeader
        title="Credentials"
        sub="Every stored non-human credential, with its owner, scope, age and use. Secret values are never shown."
        info={
          <p>
            One read-only view over API keys, virtual keys, SCIM tokens, provider keys, connector and integration
            secrets, deploy-target credentials and roles, and signing secrets. Flags: never expires (credentials issued
            here with no expiry), past expiry, unused for longer than the threshold (only where a last-used signal
            exists), owner deactivated, and over-scoped by the type's own rule. Manage each credential on the page its
            name links to.
          </p>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {inv && <AlertingCard inv={inv} />}
          <Card title={`Inventory · ${inv?.counts.total ?? 0} credentials, ${inv?.counts.flagged ?? 0} flagged`}>
            <div className={v.stack}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Field label="Type">
                  <Select
                    value={type}
                    onChange={(e) => {
                      setType(e.target.value);
                      setOffset(0);
                    }}
                    aria-label="Filter by credential type"
                  >
                    <option value={ALL}>All types</option>
                    {(inv?.types ?? [])
                      .filter((t) => t.count > 0)
                      .map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label} ({t.count})
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Flag">
                  <Select
                    value={flag}
                    onChange={(e) => {
                      setFlag(e.target.value);
                      setOffset(0);
                    }}
                    aria-label="Filter by flag"
                  >
                    <option value={ALL}>Any</option>
                    {(Object.keys(inv?.flagLabels ?? {}) as Flag[]).map((f) => (
                      <option key={f} value={f}>
                        {inv!.flagLabels[f]} ({inv!.counts.byFlag[f] ?? 0})
                      </option>
                    ))}
                    <option value="none">No flag</option>
                  </Select>
                </Field>
              </div>
              <Table
                rows={rows}
                rowKey={(r) => r.id}
                empty={<EmptyState title="No credentials match" body="Change the filters, or store a credential on its integration page." />}
                columns={[
                  {
                    key: "name",
                    header: "Credential",
                    sort: (r) => r.name.toLowerCase(),
                    render: (r) => (
                      <div className={v.stackTight}>
                        <Link to={r.manageAt} aria-label={`Manage ${r.typeLabel} ${r.name}`}>
                          {r.name}
                        </Link>
                        <span className={v.faint}>
                          {r.typeLabel}
                          {r.status !== "active" ? ` · ${r.status}` : ""}
                        </span>
                      </div>
                    ),
                  },
                  {
                    key: "owner",
                    header: "Owner / creator",
                    render: (r) =>
                      r.ownerUserId ? (
                        <span>
                          {r.ownerName ?? r.ownerUserId}
                          {r.ownerKind === "creator" ? <span className={v.faint}> (creator)</span> : null}
                          {r.ownerDisabled ? (
                            <>
                              {" "}
                              <Badge tone="danger">deactivated</Badge>
                            </>
                          ) : null}
                        </span>
                      ) : (
                        <span className={v.faint}>integration (no person)</span>
                      ),
                  },
                  { key: "scope", header: "Scope", render: (r) => <span className={v.dim}>{r.scope}</span> },
                  { key: "created", header: "Created", sort: (r) => r.createdAt, render: (r) => day(r.createdAt) },
                  {
                    key: "used",
                    header: "Last used",
                    sort: (r) => r.lastUsedAt ?? "",
                    render: (r) =>
                      r.lastUsedSignal === "none" ? (
                        <span className={v.faint} title="nothing records when this type is used">
                          not recorded
                        </span>
                      ) : r.lastUsedAt ? (
                        ago(r.lastUsedAt)
                      ) : (
                        "never"
                      ),
                  },
                  {
                    key: "expires",
                    header: "Expires",
                    sort: (r) => r.expiresAt ?? "",
                    render: (r) =>
                      r.expirySignal === "not_tracked" ? (
                        <span className={v.faint} title="held for a third party, which sets its lifetime">
                          not tracked
                        </span>
                      ) : r.expiresAt ? (
                        day(r.expiresAt)
                      ) : (
                        "never"
                      ),
                  },
                  {
                    key: "rotation",
                    header: "Since last set",
                    sort: (r) => r.ageSinceRotationDays,
                    render: (r) => (
                      <span title={r.rotationSignal === "since_created" ? "no set date recorded before this inventory existed; counted from creation" : undefined}>
                        {r.ageSinceRotationDays} d{r.rotationSignal === "since_created" ? "*" : ""}
                      </span>
                    ),
                  },
                  {
                    key: "links",
                    header: "Linked",
                    render: (r) =>
                      r.linkedAgents.length + r.linkedProjects.length === 0 ? (
                        <span className={v.faint}>—</span>
                      ) : (
                        <span className={v.dim}>
                          {[...r.linkedAgents.map((a) => a.name), ...r.linkedProjects.map((p) => `project ${p.name}`)].join(", ")}
                        </span>
                      ),
                  },
                  {
                    key: "flags",
                    header: "Flags",
                    sort: (r) => r.flags.length,
                    render: (r) =>
                      r.flags.length === 0 ? (
                        <span className={v.faint}>none</span>
                      ) : (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.flags.map((f) => (
                            <Badge key={f} tone={FLAG_TONE[f]} title={r.flagReasons[f]}>
                              {inv?.flagLabels[f] ?? f}
                            </Badge>
                          ))}
                        </div>
                      ),
                  },
                ]}
              />
              <nav aria-label="Credential pages" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={v.dim}>
                  {page.total === 0
                    ? "No credentials match"
                    : `Showing ${page.offset + 1}–${Math.min(page.offset + rows.length, page.total)} of ${page.total}`}
                </span>
                <Button size="sm" disabled={page.offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>
                  Previous page
                </Button>
                <Button
                  size="sm"
                  disabled={page.offset + page.limit >= page.total || q.isFetching}
                  onClick={() => setOffset(page.offset + page.limit)}
                >
                  Next page
                </Button>
              </nav>
              <span className={v.faint}>
                * no set date was recorded for this secret before the inventory existed; the age counts from creation.
                Linked projects and agents come from the last {inv?.linkWindowDays ?? 90} days of the usage ledger; a
                last use found on the ledger, from the last {inv?.ledgerWindowDays ?? inv?.linkWindowDays ?? 90} days.
              </span>
            </div>
          </Card>
          <Card title="What this inventory cannot see">
            <div className={v.stack}>
              <div>
                <div className={v.sectionTitle}>No last-used signal</div>
                <ul>
                  {noSignal.map((t) => (
                    <li key={t.type}>
                      <strong>{t.label}</strong>: {t.lastUsedNote}. Never flagged unused.
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className={v.sectionTitle}>Held outside the database</div>
                <ul>
                  {(inv?.notStored ?? []).map((n) => (
                    <li key={n.what}>
                      <strong>{n.what}</strong>: {n.why}.
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        </QueryGate>
      </div>
    </>
  );
}

function AlertingCard(props: { inv: CredentialInventory }) {
  const act = useAction();
  const preview = props.inv.alertPreview;
  const [days, setDays] = useState("");
  const value = days === "" ? String(props.inv.unusedDays) : days;
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <Card title="Monitoring">
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Unused after (days)" help="A credential older than this, with no recorded use in this many days, is flagged unused.">
          <Input
            type="number"
            min={1}
            max={3650}
            value={value}
            aria-label="Unused threshold in days"
            onChange={(e) => setDays(e.target.value)}
            style={{ width: 120 }}
          />
        </Field>
        <Button
          disabled={!valid || n === props.inv.unusedDays || act.busy}
          onClick={() =>
            void act.run(() => api.put("/v1/org/settings", { credentialUnusedDays: n }), `Unused threshold set to ${n} days`).then(() => setDays(""))
          }
        >
          Save
        </Button>
        <div className={v.stackTight}>
          <span>
            Governance alerts:{" "}
            {props.inv.alerting ? <Badge tone="info">on</Badge> : <Badge tone="neutral">observe only</Badge>}
          </span>
          <span className={v.faint}>
            {props.inv.alerting
              ? "Each credential type and flag with a flagged credential opens one alert episode on the next monitor pass."
              : "Flags show here only. Turn alerts on to open one alert episode per credential type and flag."}
          </span>
          {preview && !props.inv.alerting ? (
            <span role="note" aria-label="Alerts that would raise now">
              {preview.episodes === 0 ? (
                "Turning alerts on now would raise no episode: nothing is flagged."
              ) : (
                <>
                  <Badge tone="warn">heads up</Badge> Turning alerts on now would raise {preview.episodes} alert episode
                  {preview.episodes === 1 ? "" : "s"}, covering {preview.credentials} flagged credential
                  {preview.credentials === 1 ? "" : "s"}.
                </>
              )}
            </span>
          ) : null}
        </div>
        <Button
          variant={props.inv.alerting ? undefined : "primary"}
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () => api.put("/v1/org/settings", { staleCredentialAlerts: !props.inv.alerting }),
              props.inv.alerting ? "Credential alerts off (observe only)" : "Credential alerts on",
            )
          }
        >
          {props.inv.alerting ? "Turn alerts off" : "Turn alerts on"}
        </Button>
      </div>
    </Card>
  );
}
