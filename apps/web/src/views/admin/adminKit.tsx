/**
 * Shared plumbing for the admin surface: the admin route guard, catalog
 * queries (users/roles/agents/connectors/servers/teams), the owned SVG bar
 * chart (same visual as the legacy portal, tokens only), one-time secret
 * reveal, reason-required modals, and small display helpers. Everything here
 * composes the phase-1 kit — no new dependencies.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
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
import { Badge, Button, Card, EmptyState, Input, Modal, SkeletonBlock } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import a from "./admin.module.css";
import v from "../views.module.css";

// ---- admin gate -----------------------------------------------------------

export function RequireAdmin(props: { children: ReactNode }) {
  const { auth } = useSession();
  if (auth === undefined) return <SkeletonBlock lines={4} />;
  if (!auth?.isAdmin) return <Navigate to="/" replace />;
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
