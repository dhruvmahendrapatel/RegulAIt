/**
 * Shared plumbing for the admin surface: the admin route guard, catalog
 * queries (users/roles/agents/connectors/servers/teams), the owned SVG bar
 * chart (same visual as the legacy portal, tokens only), one-time secret
 * reveal, reason-required modals, and small display helpers. Everything here
 * composes the phase-1 kit — no new dependencies.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import type {
  AdminAgent,
  AdminProject,
  AdminUser,
  ComplianceProfile,
  Connector,
  CustomModelProvider,
  EgressAllowHost,
  McpServer,
  McpTool,
  Role,
  Team,
} from "../../api/adminTypes";
import { fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Modal, SkeletonBlock, Table } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import a from "./admin.module.css";
import v from "../views.module.css";

// ---- admin gate -----------------------------------------------------------

/**
 * The admin boundary. Default-deny, and it says so.
 *
 * This used to bounce a non-admin silently to Home, which is not a refusal —
 * it is a disappearance, and the person who typed the URL is left unable to
 * tell "I am not allowed" from "that page does not exist". Every governed
 * refusal in this product names itself; the client-side one now does too. The
 * gateway refuses these routes independently (they are absent from
 * `NON_ADMIN_ROUTES`), so this is the readable half of a two-sided deny, never
 * the enforcement.
 */
export function RequireAdmin(props: { children: ReactNode }) {
  const { auth } = useSession();
  if (auth === undefined) return <SkeletonBlock lines={4} />;
  if (!auth?.isAdmin) {
    return (
      <Card>
        <ErrorState
          access
          message={
            "This is an administrative surface and your account does not hold the administrator role. " +
            "It is not listed in your navigation for the same reason. The server refuses these endpoints " +
            "independently of this screen, so nothing here was hidden from you and then left reachable."
          }
        />
      </Card>
    );
  }
  return <>{props.children}</>;
}

// ---- catalog queries ------------------------------------------------------

export const adminKeys = {
  users: ["admin", "users"] as const,
  roles: ["admin", "roles"] as const,
  teams: ["admin", "teams"] as const,
  agents: ["admin", "agents"] as const,
  connectors: ["admin", "connectors"] as const,
  servers: ["admin", "servers"] as const,
  projects: ["admin", "projects"] as const,
  profiles: ["admin", "compliance-profiles"] as const,
  customProviders: ["admin", "custom-model-providers"] as const,
  egressHosts: ["admin", "egress-allow-hosts"] as const,
};

export const useUsers = () =>
  useQuery({ queryKey: adminKeys.users, queryFn: () => api.get<{ users: AdminUser[] }>("/v1/users") });
export const useRoles = () =>
  useQuery({ queryKey: adminKeys.roles, queryFn: () => api.get<{ roles: Role[] }>("/v1/roles") });
export const useTeams = () =>
  useQuery({ queryKey: adminKeys.teams, queryFn: () => api.get<{ teams: Team[] }>("/v1/teams") });
export const useAgents = () =>
  useQuery({ queryKey: adminKeys.agents, queryFn: () => api.get<{ agents: AdminAgent[] }>("/v1/agents") });
export const useConnectors = () =>
  useQuery({
    queryKey: adminKeys.connectors,
    queryFn: () => api.get<{ connectors: Connector[] }>("/v1/connectors"),
  });
export const useServers = () =>
  useQuery({ queryKey: adminKeys.servers, queryFn: () => api.get<{ servers: McpServer[] }>("/v1/servers") });
export const useProjects = () =>
  useQuery({ queryKey: adminKeys.projects, queryFn: () => api.get<{ projects: AdminProject[] }>("/v1/projects") });
/** ADR-0034 — the registered custom endpoints. Admin-only, like every other
 * catalog here; the API's projection has no field for the stored key. */
export const useCustomProviders = () =>
  useQuery({
    queryKey: adminKeys.customProviders,
    queryFn: () => api.get<{ providers: CustomModelProvider[] }>("/v1/custom-model-providers"),
  });
/** ADR-0034 — the egress allow-list. An EMPTY list means nothing is reachable;
 * that is the default-deny posture, not a loading failure. */
export const useEgressAllowHosts = () =>
  useQuery({
    queryKey: adminKeys.egressHosts,
    queryFn: () => api.get<{ hosts: EgressAllowHost[] }>("/v1/egress-allow-hosts"),
  });
export const useComplianceProfiles = () =>
  useQuery({
    queryKey: adminKeys.profiles,
    queryFn: () => api.get<{ profiles: ComplianceProfile[] }>("/v1/compliance/profiles"),
  });
export const useServerTools = (serverId: string | null | undefined) =>
  useQuery({
    queryKey: ["admin", "server-tools", serverId],
    queryFn: () => api.get<{ tools: McpTool[] }>(`/v1/servers/${serverId}/tools`),
    enabled: Boolean(serverId),
  });

/** invalidate every admin catalog + list in one go after a write */
export function useAdminInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["admin"] });
}

// ---- select options — every id becomes a name -----------------------------

export interface Opt {
  v: string;
  l: string;
}
export const userOpts = (rows: AdminUser[] | undefined): Opt[] =>
  (rows ?? []).map((u) => ({ v: u.id, l: `${u.displayName || u.email} · ${u.email}` }));
export const agentOpts = (rows: AdminAgent[] | undefined): Opt[] =>
  (rows ?? []).map((x) => ({ v: x.id, l: `${x.name} · ${x.provider} · tier ${x.tier}` }));
export const connectorOpts = (rows: Connector[] | undefined): Opt[] =>
  (rows ?? []).map((c) => ({ v: c.id, l: `${c.name} · ${c.kind}` }));
export const serverOpts = (rows: McpServer[] | undefined): Opt[] =>
  (rows ?? []).map((s) => ({ v: s.id, l: s.name }));
export const roleOpts = (rows: Role[] | undefined): Opt[] => (rows ?? []).map((r) => ({ v: r.id, l: r.name }));
export const teamOpts = (rows: Team[] | undefined): Opt[] => (rows ?? []).map((t) => ({ v: t.id, l: t.name }));
export const projectOpts = (rows: AdminProject[] | undefined): Opt[] =>
  (rows ?? []).map((p) => ({ v: p.id, l: p.name }));

/** id → display-name lookups for tables */
export function useNameMaps() {
  const users = useUsers();
  const servers = useServers();
  const roles = useRoles();
  const teams = useTeams();
  return useMemo(() => {
    const m = (pairs: Array<[string, string]>) => new Map(pairs);
    return {
      userName: m((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email])),
      userEmail: m((users.data?.users ?? []).map((u) => [u.id, u.email])),
      serverName: m((servers.data?.servers ?? []).map((s) => [s.id, s.name])),
      roleName: m((roles.data?.roles ?? []).map((r) => [r.id, r.name])),
      teamName: m((teams.data?.teams ?? []).map((t) => [t.id, t.name])),
    };
  }, [users.data, servers.data, roles.data, teams.data]);
}

// ---- one async action at a time -------------------------------------------

/** Submit-handler helper: busy flag + inline error + success toast + refresh. */
export function useAction() {
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, okMsg?: string | null): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (okMsg !== null) toast(okMsg ?? "Saved", "success");
      invalidate();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast(msg, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// ---- one async action at a time, KEEPING the refusal's structure ----------

/**
 * `useAction`'s sibling for surfaces whose whole product is the refusal.
 *
 * `useAction` flattens an error to one string, which is right for a save
 * button. It is wrong for an importer: a 422 from ADR-0069/ADR-0071 carries the
 * refused LINE NUMBERS, and a 402 from ADR-0066 carries the budget it hit.
 * Throwing that away and printing "something went wrong" is precisely the
 * failure these three slices were built not to have — so this keeps the status,
 * the error code and the whole payload, and the caller renders them.
 */
export interface ApiOutcome {
  ok: boolean;
  /** the gateway's own `error` identifier, e.g. `malformed_rows` */
  code: string | null;
  status: number | null;
  /** the gateway's own sentence — never a paraphrase, never a generic message */
  reason: string;
  /** the full body, so a caller can render `refusals[]`, `issues[]`, … */
  payload: Record<string, unknown> | null;
}

export function useApiAction() {
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApiOutcome | null>(null);

  const run = async <T,>(fn: () => Promise<T>, okMsg: string): Promise<T | null> => {
    setBusy(true);
    setOutcome(null);
    try {
      const value = await fn();
      setOutcome({
        ok: true,
        code: null,
        status: null,
        reason: okMsg,
        payload: (value ?? null) as Record<string, unknown> | null,
      });
      toast(okMsg, "success");
      invalidate();
      return value;
    } catch (e) {
      if (e instanceof ApiError) {
        const reason =
          (typeof e.payload.detail === "string" && e.payload.detail) ||
          (typeof e.payload.message === "string" && e.payload.message) ||
          e.message;
        const o: ApiOutcome = {
          ok: false,
          code: typeof e.payload.error === "string" ? e.payload.error : null,
          status: e.status,
          reason,
          payload: e.payload as Record<string, unknown>,
        };
        setOutcome(o);
        toast(`${o.code ?? `HTTP ${e.status}`} — ${reason}`, "error");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setOutcome({ ok: false, code: null, status: null, reason: msg, payload: null });
        toast(msg, "error");
      }
      invalidate();
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, outcome, setOutcome, run };
}

/**
 * The refusal/acceptance panel. `aria-live` because the reason IS the answer: a
 * screen-reader user must not have to go hunting for why the platform said no.
 */
export function OutcomePanel(props: { outcome: ApiOutcome | null; testId?: string; children?: ReactNode }) {
  const o = props.outcome;
  return (
    <div aria-live="polite" data-testid={props.testId}>
      {o && (
        <div
          className={[a.outcome, o.ok ? a.outcomeOk : a.outcomeDeny].join(" ")}
          role={o.ok ? undefined : "alert"}
        >
          <div className={v.row}>
            <span className={a.effectWord}>{o.ok ? "Accepted" : "Refused"}</span>
            {o.code && <Badge tone={o.ok ? "ok" : "danger"}>{o.code}</Badge>}
            {o.status !== null && <span className={v.faint}>HTTP {o.status}</span>}
          </div>
          <div className={a.snippet} data-testid="outcome-reason">
            {o.reason}
          </div>
          {props.children}
        </div>
      )}
    </div>
  );
}

/**
 * A per-row refusal list. Every entry NAMES ITS 1-BASED FILE LINE — ADR-0069
 * and ADR-0071 both make that a contract rather than a nicety, and a refusal
 * with no locus is an apology instead of a report.
 */
export interface RowRefusal {
  row: number;
  reason: string;
  field?: string;
}

export function RefusalList(props: { refusals: RowRefusal[] | undefined; truncated?: boolean; testId?: string }) {
  const rows = props.refusals ?? [];
  if (rows.length === 0) return null;
  return (
    <div className={v.stackTight} data-testid={props.testId}>
      <div className={v.sectionTitle}>Refused lines ({rows.length})</div>
      <Table<RowRefusal>
        rows={rows}
        rowKey={(r) => `${r.row}:${r.field ?? ""}:${r.reason.slice(0, 40)}`}
        columns={[
          { key: "line", header: "File line", width: "110px", render: (r) => <span className={v.num}>{r.row}</span> },
          { key: "field", header: "Field", render: (r) => (r.field ? <code>{r.field}</code> : <span className={v.faint}>—</span>) },
          { key: "reason", header: "Why it was refused", render: (r) => <span className={v.dim}>{r.reason}</span> },
        ]}
      />
      {props.truncated && (
        <p className={v.faint}>
          Only the first refusals are listed — the import record holds the bounded list the gateway stored.
        </p>
      )}
    </div>
  );
}

// ---- loading / error wrappers ---------------------------------------------

export function QueryGate(props: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (props.loading)
    return (
      <Card>
        <SkeletonBlock lines={5} />
      </Card>
    );
  if (props.error)
    return (
      <Card>
        <div className={v.stack}>
          <div className={v.errLine} role="alert">
            {props.error instanceof Error ? props.error.message : String(props.error)}
          </div>
          <div>
            <Button size="sm" onClick={props.onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </Card>
    );
  return <>{props.children}</>;
}

// ---- owned SVG bar chart (legacy-portal parity, tokens only) --------------

export function BarChart(props: {
  items: Array<Record<string, unknown>>;
  valueKey: string;
  label: (item: Record<string, unknown>) => string;
  format?: (v: number) => string;
  title: string;
}) {
  const items = (props.items ?? []).slice(0, 10);
  if (items.length === 0) return <EmptyState title="No data yet" />;
  const fmt = props.format ?? fmtUsd;
  const max = Math.max(...items.map((i) => Number(i[props.valueKey]) || 0), 1e-9);
  const rowH = 26;
  const w = 640;
  const short = (label: string) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(label)) return label.slice(0, 8) + "…";
    return label.length > 24 ? label.slice(0, 23) + "…" : label;
  };
  return (
    <div className={a.chartWrap}>
      <svg
        viewBox={`0 0 ${w} ${items.length * rowH}`}
        role="img"
        aria-label={props.title}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {items.map((item, i) => {
          const val = Number(item[props.valueKey]) || 0;
          const bw = Math.max(2, (val / max) * (w - 300));
          const y = i * rowH;
          return (
            <g key={i}>
              <text x={0} y={y + 16} className={a.chartLabel}>
                {short(props.label(item))}
              </text>
              <rect x={200} y={y + 5} width={bw} height={14} rx={3} className={a.chartBar} />
              <text x={206 + bw} y={y + 16} className={a.chartValue}>
                {fmt(val)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---- stat tile ------------------------------------------------------------

export function Stat(props: { value: ReactNode; label: ReactNode }) {
  return (
    <Card>
      <div className={v.stat}>
        <div className={v.statValue}>{props.value}</div>
        <div className={v.statLabel}>{props.label}</div>
      </div>
    </Card>
  );
}

// ---- one-time secret reveal -----------------------------------------------

export interface RevealedSecret {
  title: string;
  secret: string;
  note?: string;
}

export function RevealCard(props: { reveal: RevealedSecret; onDismiss: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <div className={v.stack}>
        <div className={v.row}>
          <strong>{props.reveal.title}</strong>
          <Badge tone="warn">shown once</Badge>
          <span className={v.grow} />
          <Button size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
        <div className={a.secretRow}>
          <code className={a.secretCode} data-testid="revealed-secret">
            {props.reveal.secret}
          </code>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(props.reveal.secret);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                toast("Clipboard unavailable — select the text manually", "error");
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className={v.faint}>
          This will not be shown again — the server keeps only a hash of it. {props.reveal.note ?? ""}
        </div>
      </div>
    </Card>
  );
}

// ---- reason-required modal (force deletes, MFA clear, retire…) ------------

export function ReasonModal(props: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  placeholder?: string;
  danger?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => {
    setReason("");
    setErr(null);
    props.onCancel();
  };
  const go = () => {
    if (!reason.trim()) {
      setErr("A reason is required — it becomes the audited record.");
      return;
    }
    const r = reason.trim();
    setReason("");
    setErr(null);
    props.onConfirm(r);
  };
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant={props.danger ? "danger" : "primary"} onClick={go}>
            {props.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {props.body}
        <Input
          placeholder={props.placeholder ?? "reason (required, audited)"}
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
        />
        {err && (
          <div className={v.errLine} role="alert">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- misc display helpers -------------------------------------------------

/** authed CSV download via a transient blob URL (session cookie rides along) */
export async function downloadCsv(path: string, filename: string, onError: (msg: string) => void) {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    onError(`CSV download failed (${res.status})`);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function KV(props: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <div className={a.kv}>
      {props.rows.map(([k, val], i) => (
        <div key={i} className={a.kvRow}>
          <span className={a.kvKey}>{k}</span>
          <span className={a.kvVal}>{val}</span>
        </div>
      ))}
    </div>
  );
}

/** shared select field markup (kit Select is unlabelled by itself) */
export function optionEls(opts: Opt[], placeholder?: string) {
  return (
    <>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </>
  );
}
