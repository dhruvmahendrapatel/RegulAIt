/**
 * D2 (ADR-0331; owner-approved on #453): governed removal of one flagged MCP server from the employee machines that
 * report it, at `/admin/shadow-ai/discovery-sources/addon-removals`, reached from the "MCP servers on employee
 * machines" card on Discovery sources ("Removals", and "Request removal…" on a flagged row, which prefills the form).
 *
 *  - A request asks the requester to confirm it's them (`endpoint_remediation` step-up), then waits for a second
 *    administrator's approval (ADR-0186): nothing reaches a device before that.
 *  - The org switch (`discovery_settings.endpoint_addon_removal_enabled`, read from the list route's `enabled`) is off
 *    by default (ADR-0180): while it is off the page says so and the request button is disabled. Turning it on is a
 *    `settings_relax` step-up through PUT /v1/discovery/settings; turning it off is free.
 *  - Cancel stops undelivered targets and withdraws a pending approval; a delivered directive keeps its real outcome.
 *    It narrows, so it needs no step-up.
 * Admin-only like the parent page. Lazy: its own chunk, loaded only when opened.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { errorText, fmtDateTime, plural, providerLabel } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { useSession } from "../../../session/SessionContext";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, Input, RowActions, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useAction, useUserPicker } from "../adminKit";
import { Crumbs } from "./DiscoveryListPages";
import { launches, linkIdentity, type EndpointMcpLinkKind, type EndpointMcpServersPage, type EndpointMcpServerView } from "./endpointMcpModel";
import type { DiscoverySettingsView } from "./discoverySourcesModel";
import {
  cancellable,
  OUTCOME_CODE_TEXT,
  REMOVAL_MAX_DAYS,
  REMOVAL_REASON_MAX,
  REMOVAL_STATE_LABEL,
  REMOVAL_STATE_TONE,
  removalBody,
  removalSubject,
  removalsUrl,
  removalUrl,
  shownCounts,
  TARGET_LABEL,
  TARGET_TONE,
  type CreatedRemoval,
  type RemovalDetail,
  type RemovalsPage,
  type RemovalTargetView,
  type RemovalView,
} from "./discoverySubpagesModel";
import sp from "./discoverySubpages.module.css";
import v from "../../views.module.css";

const REMOVALS_KEY = ["admin", "discovery", "addon-removals"] as const;

/** one flagged server identity, as the request names it */
interface Candidate {
  key: string;
  identityKind: EndpointMcpLinkKind;
  identity: string;
  packageVersion: string | null;
  serverName: string;
  label: string;
  devices: Map<string, string>;
}
const keyOf = (kind: string, identity: string, version: string | null, name: string) => [kind, identity, version ?? "", name].join("\u0000");
const flaggedText = (r: Pick<EndpointMcpServerView, "risks" | "riskyTools" | "secretTypes">) =>
  [r.risks.length ? plural(r.risks.length, "risk flag") : "", r.riskyTools.length ? plural(r.riskyTools.length, "risky tool") : "", r.secretTypes.length ? plural(r.secretTypes.length, "secret type") : ""]
    .filter(Boolean)
    .join(", ");

function TargetCountBadges(props: { r: RemovalView }) {
  const counts = shownCounts(props.r.targets);
  if (counts.length === 0) return <span className={v.faint}>{props.r.state === "awaiting_approval" ? "written on approval" : "none"}</span>;
  return (
    <span className={sp.badges}>
      {counts.map(([s, n]) => (
        <Badge key={s} tone={TARGET_TONE[s]}>{`${n} ${TARGET_LABEL[s]}`}</Badge>
      ))}
    </span>
  );
}

export default function AddonRemovalsPage() {
  const act = useAction();
  const [params, setParams] = useSearchParams();
  const me = useSession().auth?.userId ?? null;
  const users = useUserPicker();
  const userName = (id: string | null) => {
    if (!id) return "—";
    const u = users.data?.users.find((x) => x.id === id);
    return u ? u.displayName || u.email : id === me ? "you" : id;
  };
  const list = useInfiniteQuery({
    queryKey: [...REMOVALS_KEY, "list"],
    queryFn: ({ pageParam }) => api.get<RemovalsPage>(removalsUrl(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const first = list.data?.pages[0];
  const removals = list.data?.pages.flatMap((p) => p.items);
  const enabled = first?.enabled ?? null;
  const settings = useQuery({ queryKey: ["admin", "discovery", "settings"], queryFn: () => api.get<DiscoverySettingsView>("/v1/discovery/settings"), enabled: enabled === false });
  const selectedId = params.get("removal");
  const select = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set("removal", id);
      else n.delete("removal");
      return n;
    }, { replace: true });
  const [cancelling, setCancelling] = useState<RemovalView | null>(null);

  const turnOn = () =>
    void act.run(async () => {
      const version = settings.data?.version ?? (await api.get<DiscoverySettingsView>("/v1/discovery/settings")).version;
      await withStepUp((h) => stepUpApi.put("/v1/discovery/settings", { version, endpointAddonRemoval: true }, h));
      return "Removal is on for this organisation";
    });
  const turnOff = () =>
    void act.run(async () => {
      const s = await api.get<DiscoverySettingsView>("/v1/discovery/settings");
      await api.put("/v1/discovery/settings", { version: s.version, endpointAddonRemoval: false });
      return "Removal is off for this organisation";
    });
  const cancel = () => {
    const r = cancelling;
    if (!r) return;
    setCancelling(null);
    void act.run(async () => {
      const out = await api.post<{ cancelled: number; alreadyCancelled: boolean; removal: RemovalView }>(`/v1/discovery/endpoint-addon-removals/${r.id}/cancel`, {});
      if (out.alreadyCancelled) return "It was already cancelled";
      const waiting = out.removal.targets.delivered;
      return `Cancelled: ${plural(out.cancelled, "endpoint")} stopped${waiting ? `, ${waiting} already delivered keep their outcome` : ""}`;
    });
  };
  const awaiting = (removals ?? []).filter((r) => r.state === "awaiting_approval").length;

  return (
    <>
      <Crumbs here="Removals" mid="MCP servers on employee machines" />
      <PageHeader
        title="MCP server removals"
        sub="Removes one flagged MCP server from the endpoints that report it. A removal needs you to confirm it's you, then a second administrator's approval. Endpoints already reached keep their real outcome if you cancel."
        info={
          <>
            regulAIt sends each endpoint agent a signed instruction to delete that one server entry from a user-writable MCP config, and the agent reports what it
            did. Only servers the endpoint agent reported are targeted. Nothing reaches a device until the second administrator approves, and every step is
            audited.
          </>
        }
      />
      <div className={v.stack}>
        {enabled === false && (
          <div className={sp.warn} role="status" data-testid="removal-off">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3 2 21h20L12 3z" />
              <path d="M12 10v5M12 18h.01" />
            </svg>
            <div className={v.stackTight}>
              <span id="removal-off-text">
                <strong>Removal is off for this organisation.</strong> Requests are refused until an admin turns it on, which asks you to confirm it&apos;s you and is
                audited.
              </span>
              <span>
                <Button size="sm" disabled={act.busy} onClick={turnOn}>
                  Turn removal on…
                </Button>
              </span>
            </div>
          </div>
        )}
        {first && !first.signerConfigured && (
          <p className={sp.note} role="note" data-testid="signer-missing">
            No removal instruction can be signed yet: the signing key for endpoint instructions is not set up. An approved removal waits, and nothing reaches a
            device until the key is in place.
          </p>
        )}
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RequestForm enabled={enabled} me={me} users={users.data?.users ?? []} usersPending={users.isPending} />
        <Card
          title={
            <>
              Removals{" "}
              {removals && (
                <span className={v.faint}>
                  {first?.total != null ? first.total : removals.length}
                  {awaiting ? ` · ${awaiting} awaiting approval` : ""}
                </span>
              )}
            </>
          }
          actions={enabled ? <Button size="sm" disabled={act.busy} onClick={turnOff}>Turn removal off</Button> : undefined}
        >
          <div className={v.stack} data-testid="removals">
            <Table<RemovalView>
              rows={removals}
              rowKey={(r) => r.id}
              loading={list.isPending}
              error={list.error}
              onRetry={() => void list.refetch()}
              empty={<EmptyState title="No removal yet" body="Removals you or another admin request appear here, newest first." />}
              columns={[
                {
                  key: "server",
                  header: "MCP server",
                  render: (r) => (
                    <>
                      <strong>{r.serverName ?? r.identity}</strong>
                      <div className={`${v.faint} ${v.mono}`}>{removalSubject({ ...r, serverName: null })}</div>
                    </>
                  ),
                },
                { key: "requested", header: "Requested", render: (r) => `${fmtDateTime(r.createdAt)} · ${userName(r.createdBy)}` },
                { key: "state", header: "State", render: (r) => <Badge tone={REMOVAL_STATE_TONE[r.state]}>{REMOVAL_STATE_LABEL[r.state]}</Badge> },
                { key: "endpoints", header: "Endpoints", render: (r) => <TargetCountBadges r={r} /> },
                {
                  key: "actions",
                  header: "",
                  srHeader: "Actions",
                  render: (r) => (
                    <RowActions
                      slot="6rem"
                      primary={
                        <Button size="sm" aria-label={`Details, ${r.serverName ?? r.identity}`} aria-pressed={selectedId === r.id} onClick={() => select(selectedId === r.id ? null : r.id)}>
                          Details
                        </Button>
                      }
                      secondary={
                        cancellable(r) ? (
                          <Button size="sm" disabled={act.busy} aria-label={`Cancel, ${r.serverName ?? r.identity}`} onClick={() => setCancelling(r)}>
                            Cancel
                          </Button>
                        ) : null
                      }
                    />
                  ),
                },
              ]}
            />
            {list.hasNextPage && (
              <div>
                <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        </Card>
        {selectedId && <RemovalDetailCard id={selectedId} busy={act.busy} onCancel={setCancelling} onClose={() => select(null)} />}
      </div>
      <ConfirmModal
        open={!!cancelling}
        danger
        title={`Cancel the removal of ${cancelling?.serverName ?? cancelling?.identity ?? ""}?`}
        confirmLabel="Cancel removal"
        onCancel={() => setCancelling(null)}
        onConfirm={cancel}
        body={
          cancelling?.state === "awaiting_approval" ? (
            <p>The pending approval is withdrawn, so nobody can approve it later. Nothing has reached a device. Cancelling needs no step-up and is audited.</p>
          ) : (
            <p>
              {`Cancelling stops the ${plural(cancelling?.targets.pending ?? 0, "endpoint")} not reached yet. Endpoints already reached keep their real outcome, which is still recorded. Cancelling needs no step-up and is audited.`}
            </p>
          )
        }
      />
    </>
  );
}

function RequestForm(props: { enabled: boolean | null; me: string | null; users: Array<{ id: string; displayName: string; email: string; isAdmin: boolean; disabledAt: string | null }>; usersPending: boolean }) {
  const act = useAction();
  const [params] = useSearchParams();
  // the flagged servers the endpoint agent reported (the first 200, with a risk flag)
  const flagged = useQuery({
    queryKey: ["admin", "discovery", "endpoint-mcp-servers", "flagged"],
    queryFn: () => api.get<EndpointMcpServersPage>("/v1/discovery/endpoint-mcp-servers?risky=true&limit=200"),
  });
  const candidates = useMemo(() => {
    const out = new Map<string, Candidate>();
    for (const r of flagged.data?.items ?? []) {
      const id = linkIdentity(r);
      if (!id) continue;
      const key = keyOf(id.identityKind, id.identity, r.packageVersion, r.serverName);
      const c = out.get(key) ?? { key, ...id, packageVersion: r.packageVersion, serverName: r.serverName, label: `${r.serverName} · ${launches(r)} (${flaggedText(r) || "flagged"})`, devices: new Map() };
      c.devices.set(r.deviceId, r.devicePseudonym);
      out.set(key, c);
    }
    // a row's "Request removal…" names its server in the URL: offered even past the first page
    const kind = params.get("identityKind") as EndpointMcpLinkKind | null;
    const identity = params.get("identity");
    const name = params.get("serverName") ?? "";
    if (kind && identity && ["package", "host", "command"].includes(kind)) {
      const key = keyOf(kind, identity, params.get("packageVersion"), name);
      if (!out.has(key)) out.set(key, { key, identityKind: kind, identity, packageVersion: params.get("packageVersion"), serverName: name, label: `${name || identity} · ${identity}`, devices: new Map() });
    }
    return [...out.values()];
  }, [flagged.data, params]);
  const linkedKey = (() => {
    const kind = params.get("identityKind");
    const identity = params.get("identity");
    return kind && identity ? keyOf(kind, identity, params.get("packageVersion"), params.get("serverName") ?? "") : "";
  })();
  const linkedDevice = params.get("device");
  const [chosen, setChosen] = useState(linkedKey);
  const [scopeKind, setScopeKind] = useState<"recent" | "device">(linkedDevice ? "device" : "recent");
  const [days, setDays] = useState("30");
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [blockReinstall, setBlockReinstall] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => setChosen(linkedKey), [linkedKey]);
  const candidate = candidates.find((c) => c.key === chosen) ?? null;
  const deviceLabel = linkedDevice ? (candidate?.devices.get(linkedDevice) ?? "the device it was reported on") : null;
  const approvers = props.users.filter((u) => u.isAdmin && !u.disabledAt && u.id !== props.me);
  const approverName = approvers.find((u) => u.id === approver);
  const off = props.enabled !== true;

  const submit = async () => {
    setDone(null);
    if (!candidate) return setFormError("Choose the flagged MCP server to remove.");
    const n = Number(days);
    if (scopeKind === "recent" && (!Number.isInteger(n) || n < 1 || n > REMOVAL_MAX_DAYS)) return setFormError(`Days is a whole number from 1 to ${REMOVAL_MAX_DAYS}.`);
    if (!approver) return setFormError("Choose the administrator who approves it.");
    if (!reason.trim()) return setFormError("Say why it is removed: the approver reads it, and it is kept in the audit log.");
    setFormError(null);
    const body = removalBody({
      identityKind: candidate.identityKind,
      identity: candidate.identity,
      packageVersion: candidate.packageVersion,
      serverName: candidate.serverName || null,
      scope: scopeKind === "device" && linkedDevice ? { kind: "device", deviceId: linkedDevice } : { kind: "recent", days: n },
      blockReinstall,
      approverUserId: approver,
      reason,
    });
    const ok = await act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<CreatedRemoval>("/v1/discovery/endpoint-addon-removals", body, h));
      const who = approverName ? approverName.displayName || approverName.email : "the approver";
      const said = `Requested: ${plural(out.resolved, "config entry", "config entries")} on ${plural(out.devices, "endpoint")}. Waiting for ${who} to approve it.`;
      setDone(said);
      return said;
    });
    if (ok) setReason("");
  };

  return (
    <Card title="Request a removal" className={sp.requestCard}>
      <div className={v.stack} data-testid="removal-request">
        <div className={v.row}>
          <Field label="Flagged MCP server" grow error={formError}>
            <Select value={chosen} disabled={flagged.isPending} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{flagged.isPending ? "Loading…" : flagged.error ? "Could not read the reported servers" : candidates.length ? "Choose a server" : "No flagged server reported"}</option>
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Endpoints">
            <Select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as "recent" | "device")}>
              <option value="recent">Every endpoint that reported it recently</option>
              {linkedDevice && <option value="device">{`Only ${deviceLabel}`}</option>}
            </Select>
          </Field>
          {scopeKind === "recent" && (
            <Field label="Reported in the last (days)">
              <Input type="number" min={1} max={REMOVAL_MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          )}
          <Field label="Approver (another admin)">
            <Select value={approver} disabled={props.usersPending} onChange={(e) => setApprover(e.target.value)}>
              <option value="">{props.usersPending ? "Loading…" : approvers.length ? "Choose an administrator" : "No other administrator"}</option>
              {approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.email}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {candidate && candidate.devices.size > 0 && (
          <p className={v.faint}>{`${plural(candidate.devices.size, "endpoint")} in the latest reports show it. The gateway resolves the exact endpoints when you ask.`}</p>
        )}
        <Field label="Reason (shown to the approver and in the audit log)">
          <Textarea rows={2} maxLength={REMOVAL_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <label className={v.row}>
          <input type="checkbox" checked={blockReinstall} onChange={(e) => setBlockReinstall(e.target.checked)} /> Ask that it is not reinstalled
        </label>
        <p className={v.faint}>The reinstall block is recorded and audited. Devices do not enforce it yet. Each device reports whether its developer was told.</p>
        <div className={sp.submitRow}>
          <span className={sp.step}>Asks you to confirm it&apos;s you</span>
          <span className={sp.step}>{`Then waits for ${approverName ? approverName.displayName || approverName.email : "the approver"}`}</span>
          <Button variant="primary" disabled={off || act.busy} aria-describedby={off ? "removal-off-hint" : undefined} onClick={() => void submit()}>
            Request removal
          </Button>
        </div>
        {off && (
          <p id="removal-off-hint" className={v.faint}>
            {props.enabled === null ? "Checking whether removal is on for this organisation…" : "Turn removal on above before you request one."}
          </p>
        )}
        {done && (
          <p role="status" data-testid="removal-requested">
            {done}
          </p>
        )}
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Card>
  );
}

function RemovalDetailCard(props: { id: string; busy: boolean; onCancel: (r: RemovalView) => void; onClose: () => void }) {
  const detail = useInfiniteQuery({
    queryKey: [...REMOVALS_KEY, "detail", props.id],
    queryFn: ({ pageParam }) => api.get<RemovalDetail>(removalUrl(props.id, pageParam)),
    initialPageParam: 0,
    getNextPageParam: (p) => p.targets.nextOffset ?? undefined,
  });
  const r = detail.data?.pages[0]?.removal;
  const targets = detail.data?.pages.flatMap((p) => p.targets.items);
  if (detail.isPending)
    return (
      <Card title="Removal">
        <SkeletonBlock lines={4} />
      </Card>
    );
  if (!r)
    return (
      <Card title="Removal" actions={<Button size="sm" onClick={props.onClose}>Close</Button>}>
        <ErrorState title="Couldn't load this removal" message={detail.error ? errorText(detail.error) : "The removal could not be read."} onRetry={() => void detail.refetch()} />
      </Card>
    );
  const reached = r.targets.total - r.targets.pending - r.targets.cancelled;
  return (
    <Card
      title={`${r.serverName ?? r.identity} · per endpoint`}
      actions={
        <>
          {cancellable(r) && (
            <Button size="sm" variant="danger" disabled={props.busy} onClick={() => props.onCancel(r)}>
              Cancel removal
            </Button>
          )}{" "}
          <Button size="sm" onClick={props.onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className={v.stack} data-testid="removal-detail">
        <p>
          <Badge tone={REMOVAL_STATE_TONE[r.state]}>{REMOVAL_STATE_LABEL[r.state]}</Badge> <span className={v.mono}>{removalSubject(r)}</span>
        </p>
        <p className={v.faint}>
          {`Reason: ${r.reason}. Expires ${fmtDateTime(r.expiresAt)}. Reinstall block ${r.blockReinstall ? "requested" : "not requested"}${r.blockReinstall && !r.blockEnforced ? " (recorded, not enforced on devices yet)" : ""}.`}
        </p>
        {cancellable(r) && (
          <p className={v.faint}>
            {r.state === "awaiting_approval"
              ? "Cancelling withdraws the pending approval. Nothing has reached a device. No step-up; audited."
              : `Cancelling stops the ${plural(r.targets.pending, "pending endpoint")}. The ${reached} already reached keep their outcome. No step-up; audited.`}
          </p>
        )}
        <Table<RemovalTargetView>
          rows={targets}
          rowKey={(t) => t.id}
          error={detail.error}
          onRetry={() => void detail.refetch()}
          empty={
            <EmptyState
              title={r.state === "awaiting_approval" ? "No endpoint is targeted yet" : "No endpoint"}
              body={r.state === "awaiting_approval" ? "The endpoints are written when the second administrator approves, and only if they are unchanged since the request." : undefined}
            />
          }
          columns={[
            {
              key: "device",
              header: "Device",
              render: (t) => (
                <>
                  <span className={v.mono}>{t.devicePseudonym}</span>
                  <div className={v.faint}>{`${providerLabel(t.provider)} · ${t.serverName}`}</div>
                </>
              ),
            },
            { key: "outcome", header: "Outcome", render: (t) => <Badge tone={TARGET_TONE[t.status]}>{TARGET_LABEL[t.status]}</Badge> },
            {
              key: "code",
              header: "Code",
              render: (t) =>
                t.code ? (
                  <>
                    <span className={v.mono}>{t.code}</span>
                    {OUTCOME_CODE_TEXT[t.code] && <div className={v.faint}>{OUTCOME_CODE_TEXT[t.code]}</div>}
                  </>
                ) : (
                  <span className={v.faint}>—</span>
                ),
            },
            { key: "notified", header: "Developer told", render: (t) => (t.notified === null ? <span className={v.faint}>—</span> : t.notified ? "Yes" : "No") },
            { key: "when", header: "When", render: (t) => (t.reportedAt ?? t.deliveredAt ? fmtDateTime(t.reportedAt ?? t.deliveredAt) : <span className={v.faint}>—</span>) },
          ]}
        />
        {detail.hasNextPage && (
          <div>
            <Button disabled={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>
              {detail.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
        <p className={v.faint}>The approver decides it in their approvals, confirming it&apos;s them.</p>
      </div>
    </Card>
  );
}
