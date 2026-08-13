/**
 * ADR-0066 §2/§3 — VIRTUAL KEYS, given the surface the ADR disclosed it did not
 * have. Nothing about the contract changes here; this is the screen.
 *
 * FIVE THINGS THIS PAGE EXISTS TO PUT IN FRONT OF A HUMAN:
 *
 *  - **The ceiling is the headline, not a footnote.** A virtual key NARROWS its
 *    owner's entitlements and can never widen them. That sentence leads the
 *    page, is repeated on the issue form, and is what the allow-list field's
 *    help text says — because the single most likely operator mistake is to
 *    believe that listing a model on a key GRANTS it.
 *  - **The token is shown exactly once.** Issuance renders the plaintext in a
 *    one-time reveal that says so; the server keeps only a sha256 and there is
 *    no route that returns it again. This page never asks for one.
 *  - **Spend has two numbers, and they are shown apart.** `spentUsd` is the
 *    ENFORCEMENT counter the 402 is computed from; `meteredUsd` is the sum of
 *    the `usage_events` rows that reference the key. They agree unless a ledger
 *    row was pruned — which is exactly the thing that should be visible rather
 *    than assumed, so both are rendered and the gap is called out.
 *  - **A refusal renders its own reason.** `not_key_issuer` (owning a key does
 *    not let you raise its ceiling) and `expiry_in_the_past` are the two an
 *    operator will actually hit, and both arrive as the gateway's own sentence.
 *  - **Revoked is a state, not a deletion.** Revoke never deletes: the spend
 *    rows and the audit trail still resolve the id, and the table says so.
 *
 * House pattern: react-router + TanStack Query + the owned kit, following
 * `RegulAItLlmPage.tsx` and `TracesPage.tsx`.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd, shortId } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import {
  KV,
  OutcomePanel,
  QueryGate,
  RevealCard,
  Stat,
  optionEls,
  useAgents,
  useApiAction,
  useNameMaps,
  useUsers,
  userOpts,
  type RevealedSecret,
} from "../adminKit";
import v from "../../views.module.css";

// ---------------------------------------------------------------------------
// mirrors of the gateway's `publicKey()` projection. Note what is ABSENT and
// stays absent: the token. There is no field for it and no query that asks.
// ---------------------------------------------------------------------------

interface VirtualKey {
  id: string;
  name: string;
  userId: string;
  allowedModels: string[] | null;
  budgetUsd: number | null;
  spentUsd: number;
  budgetRemainingUsd: number | null;
  upstreamCredentialId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  active: boolean;
}

interface KeyUsage {
  key: VirtualKey;
  meteredUsd: number;
  events: number;
  unpricedEvents: number;
}

interface ModelCredential {
  id: string;
  provider: string;
  baseUrl: string | null;
  createdAt: string;
}

/** the issue response is a key PLUS the one-time token */
type IssuedKey = VirtualKey & { token: string };

// ---------------------------------------------------------------------------

function keyState(k: VirtualKey): { tone: "ok" | "danger" | "warn"; word: string } {
  if (k.revokedAt) return { tone: "danger", word: "revoked" };
  if (!k.active) return { tone: "warn", word: "expired" };
  return { tone: "ok", word: "active" };
}

/** one entry per line — an allow-list is a list, and a comma-separated blob in
 * a single-line input is how a stray space becomes an entry that matches
 * nothing. Blank lines are dropped; an EMPTY result is meaningful and is kept. */
function parseAllowList(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function VirtualKeysPage() {
  const act = useApiAction();
  const users = useUsers();
  const agents = useAgents();
  const names = useNameMaps();

  const keys = useQuery({
    queryKey: ["admin", "virtual-keys"],
    queryFn: () => api.get<{ keys: VirtualKey[] }>("/v1/virtual-keys"),
  });
  const credentials = useQuery({
    queryKey: ["admin", "model-credentials"],
    queryFn: () => api.get<{ credentials: ModelCredential[] }>("/v1/model-credentials"),
  });

  // issue form
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [allowList, setAllowList] = useState("");
  const [budget, setBudget] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [credentialId, setCredentialId] = useState("");

  // one-time reveal + per-key panels
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<VirtualKey | null>(null);

  // edit (issuer-only settings)
  const [editing, setEditing] = useState<VirtualKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editRestrict, setEditRestrict] = useState(false);
  const [editAllowList, setEditAllowList] = useState("");
  const [editBudget, setEditBudget] = useState("");
  const [editExpires, setEditExpires] = useState("");

  const usage = useQuery({
    queryKey: ["admin", "virtual-key-usage", selected],
    enabled: Boolean(selected),
    queryFn: () => api.get<KeyUsage>(`/v1/virtual-keys/${selected}/usage`),
  });

  /** every string a key's allow-list may legitimately name: an agent id OR a
   * provider-native model id, because the gateway matches on both. */
  const admissible = useMemo(
    () =>
      (agents.data?.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        model: a.model,
      })),
    [agents.data],
  );

  const rows = keys.data?.keys ?? [];

  const openEdit = (k: VirtualKey) => {
    setEditing(k);
    setEditName(k.name);
    setEditRestrict(k.allowedModels !== null);
    setEditAllowList((k.allowedModels ?? []).join("\n"));
    setEditBudget(k.budgetUsd === null ? "" : String(k.budgetUsd));
    setEditExpires(k.expiresAt ? k.expiresAt.slice(0, 16) : "");
  };

  const issue = async () => {
    const body: Record<string, unknown> = { name: name.trim() };
    if (ownerId) body.userId = ownerId;
    if (restrict) body.allowedModels = parseAllowList(allowList);
    if (budget.trim()) body.budgetUsd = Number(budget);
    if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
    if (credentialId) body.upstreamCredentialId = credentialId;

    const issued = await act.run(
      () => api.post<IssuedKey>("/v1/virtual-keys", body),
      "Virtual key issued — the token below is the only time it will ever be shown.",
    );
    if (!issued) return;
    setReveal({
      title: `Virtual key '${issued.name}'`,
      secret: issued.token,
      note:
        "Paste it into the client's API-key setting. It reaches the dispatch surfaces and nothing else: " +
        "minting keys, editing grants and reading credentials are unreachable on it by construction.",
    });
    setName("");
    setAllowList("");
    setBudget("");
    setExpiresAt("");
    setCredentialId("");
    setRestrict(false);
    void keys.refetch();
  };

  const saveEdit = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = {};
    if (editName.trim() && editName.trim() !== editing.name) body.name = editName.trim();
    body.allowedModels = editRestrict ? parseAllowList(editAllowList) : null;
    body.budgetUsd = editBudget.trim() === "" ? null : Number(editBudget);
    body.expiresAt = editExpires === "" ? null : new Date(editExpires).toISOString();
    const ok = await act.run(
      () => api.patch<VirtualKey>(`/v1/virtual-keys/${editing.id}`, body),
      "Key settings saved.",
    );
    if (ok) {
      setEditing(null);
      void keys.refetch();
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    const ok = await act.run(
      () => api.del<VirtualKey>(`/v1/virtual-keys/${target.id}`),
      `Key '${target.name}' revoked — it authenticates nothing from this moment on.`,
    );
    if (ok) void keys.refetch();
  };

  return (
    <>
      <PageHeader
        title="Virtual keys"
        sub={
          "A credential regulAIt mints and hands to a developer INSTEAD of the vendor key we hold. It carries an " +
          "owning user, an optional model allow-list, an optional lifetime budget and an optional expiry."
        }
      />
      <div className={v.stack}>
        {/* --- THE CEILING. First thing on the page, deliberately. ------- */}
        <Card title="What a virtual key can and cannot do">
          <div className={v.stack}>
            <p>
              <strong>A virtual key only ever NARROWS.</strong> A call on it is allowed when — and only
              when — the <em>owning user</em> is entitled to the served agent by the policy kernel,{" "}
              <em>and</em> the key&apos;s allow-list admits that agent, <em>and</em> its budget is not
              exhausted. Listing a model on a key does not grant it: a key naming a model its owner was
              never granted still denies.
            </p>
            <p className={v.dim}>
              A virtual key is not an identity. It reaches the dispatch surfaces (
              <code>/v1/chat/completions</code>, <code>/v1/messages</code>, <code>GET /v1/models</code>,{" "}
              <code>/v1/agents/:id/invoke</code>, <code>GET /v1/me</code>) and nothing else, whatever its
              owner&apos;s own rights are — minting keys, editing grants and reading credentials are
              unreachable on it, and it cannot be exchanged for a session at <code>/auth/login-with-key</code>.
              A key issued by an admin is <strong>not</strong> an admin.
            </p>
            <p className={v.faint}>
              The budget is a LIFETIME cap, not a monthly one — there is no per-period reset; rotate the
              key. The first crossing is allowed (measured cost is only knowable after the call returns)
              and every call after it is refused with a 402 naming the figure.
            </p>
          </div>
        </Card>

        {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}

        {/* --- issue ----------------------------------------------------- */}
        <Card title="Issue a key">
          <div className={v.stack}>
            <div className={v.row}>
              <Field label="Name" grow>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. contractor-ide"
                  data-testid="vk-name"
                />
              </Field>
              <Field label="Owner — whose entitlements this key narrows">
                <Select
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  data-testid="vk-owner"
                >
                  {optionEls(userOpts(users.data?.users), "me (the signed-in admin)")}
                </Select>
              </Field>
            </div>

            <div className={v.row}>
              <Field label="Lifetime budget (USD) — blank means no per-key cap">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="no cap"
                  data-testid="vk-budget"
                />
              </Field>
              <Field label="Expires — blank means no expiry">
                <Input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  data-testid="vk-expires"
                />
              </Field>
              <Field label="Pinned platform credential (admin only)">
                <Select
                  value={credentialId}
                  onChange={(e) => setCredentialId(e.target.value)}
                  data-testid="vk-credential"
                >
                  {optionEls(
                    (credentials.data?.credentials ?? []).map((c) => ({
                      v: c.id,
                      l: `${c.provider}${c.baseUrl ? ` · ${c.baseUrl}` : ""}`,
                    })),
                    "none — resolve normally",
                  )}
                </Select>
              </Field>
            </div>

            <label className={v.row}>
              <input
                type="checkbox"
                checked={restrict}
                onChange={(e) => setRestrict(e.target.checked)}
                data-testid="vk-restrict"
              />
              <span>Restrict this key to specific agents / models</span>
            </label>
            {restrict && (
              <>
                <Field
                  label="Allow-list — one agent id or provider-native model id per line"
                  grow
                >
                  <Textarea
                    rows={4}
                    value={allowList}
                    onChange={(e) => setAllowList(e.target.value)}
                    spellCheck={false}
                    data-testid="vk-allowlist"
                  />
                </Field>
                <p className={v.faint}>
                  This can only <strong>subtract</strong>. An entry the owner is not entitled to stays
                  denied. Leaving the box ticked with an EMPTY list means <em>nothing</em>, and is
                  honoured as written — a key someone deliberately emptied does not become a key that
                  allows everything.
                </p>
                {admissible.length > 0 && (
                  <p className={v.faint}>
                    Registered agents you can name:{" "}
                    {admissible
                      .slice(0, 12)
                      .map((a) => (a.model ? `${a.name} (${a.model})` : a.name))
                      .join(", ")}
                    {admissible.length > 12 ? ", …" : ""}
                  </p>
                )}
              </>
            )}

            <div className={v.row}>
              <Button
                variant="primary"
                disabled={act.busy || !name.trim()}
                onClick={() => void issue()}
                data-testid="vk-issue"
              >
                Issue key
              </Button>
              <span className={v.faint}>
                The token is returned once and never stored — only its sha256 reaches the database.
              </span>
            </div>
            <OutcomePanel outcome={act.outcome} testId="vk-outcome" />
          </div>
        </Card>

        {/* --- the keys --------------------------------------------------- */}
        <Card title="Issued keys">
          <QueryGate loading={keys.isLoading} error={keys.error} onRetry={() => void keys.refetch()}>
            {rows.length === 0 ? (
              <EmptyState
                title="No virtual keys yet"
                body="Issue one above to hand a developer a credential that narrows — rather than sharing the vendor key."
              />
            ) : (
              <Table<VirtualKey>
                rows={rows}
                rowKey={(k) => k.id}
                columns={[
                  {
                    key: "name",
                    header: "Key",
                    render: (k) => (
                      <Button size="sm" variant="ghost" onClick={() => setSelected(k.id)}>
                        {k.name}
                      </Button>
                    ),
                  },
                  {
                    key: "owner",
                    header: "Owner (the ceiling)",
                    render: (k) => names.userEmail.get(k.userId) ?? shortId(k.userId),
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (k) => {
                      const st = keyState(k);
                      return <Badge tone={st.tone}>{st.word}</Badge>;
                    },
                  },
                  {
                    key: "allow",
                    header: "Narrowed to",
                    render: (k) =>
                      k.allowedModels === null ? (
                        <span className={v.faint}>owner&apos;s entitlements only</span>
                      ) : k.allowedModels.length === 0 ? (
                        <Badge tone="danger" title="an empty allow-list admits nothing">
                          nothing
                        </Badge>
                      ) : (
                        <span className={v.mono}>{k.allowedModels.join(", ")}</span>
                      ),
                  },
                  {
                    key: "budget",
                    header: "Budget",
                    render: (k) =>
                      k.budgetUsd === null ? (
                        <span className={v.faint}>no cap</span>
                      ) : (
                        <span className={v.num}>{fmtUsd(k.budgetUsd)}</span>
                      ),
                  },
                  {
                    key: "spent",
                    header: "Spent (enforcement counter)",
                    render: (k) => <span className={v.num}>{fmtUsd(k.spentUsd)}</span>,
                  },
                  {
                    key: "remaining",
                    header: "Remaining",
                    render: (k) =>
                      k.budgetRemainingUsd === null ? (
                        <span className={v.faint}>n/a — no cap</span>
                      ) : k.budgetRemainingUsd === 0 ? (
                        <Badge tone="danger">exhausted</Badge>
                      ) : (
                        <span className={v.num}>{fmtUsd(k.budgetRemainingUsd)}</span>
                      ),
                  },
                  {
                    key: "expires",
                    header: "Expires",
                    render: (k) =>
                      k.expiresAt ? new Date(k.expiresAt).toLocaleString() : <span className={v.faint}>never</span>,
                  },
                  {
                    key: "used",
                    header: "Last used",
                    render: (k) => (k.lastUsedAt ? ago(k.lastUsedAt) : <span className={v.faint}>never</span>),
                  },
                  {
                    key: "act",
                    header: "",
                    render: (k) => (
                      <span className={v.row}>
                        <Button size="sm" onClick={() => openEdit(k)} data-testid={`vk-edit-${k.name}`}>
                          Settings
                        </Button>
                        {!k.revokedAt && (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setRevoking(k)}
                            data-testid={`vk-revoke-${k.name}`}
                          >
                            Revoke
                          </Button>
                        )}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </QueryGate>
          <p className={v.faint}>
            Revoking never deletes: the <code>usage_events</code> rows and the audit trail still have to
            resolve the id, so a revoked key stays listed with its history intact.
          </p>
        </Card>

        {/* --- per-key spend, both numbers ------------------------------- */}
        {selected && (
          <Card
            title="Key spend — the counter and the ledger, side by side"
            actions={
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
            }
          >
            <QueryGate
              loading={usage.isLoading}
              error={usage.error}
              onRetry={() => void usage.refetch()}
            >
              {usage.data && (
                <div className={v.stack}>
                  <div className={v.grid}>
                    <Stat value={fmtUsd(usage.data.key.spentUsd)} label="Enforcement counter (spentUsd)" />
                    <Stat value={fmtUsd(usage.data.meteredUsd)} label="Ledger total (usage_events)" />
                    <Stat value={usage.data.events} label="Billed calls" />
                    <Stat value={usage.data.unpricedEvents} label="Calls with no price" />
                  </div>
                  {Math.abs(usage.data.key.spentUsd - usage.data.meteredUsd) > 0.000001 ? (
                    <div className={v.errLine} role="alert">
                      These two disagree. The counter is what the 402 is computed from; the ledger is the
                      sum of the <code>usage_events</code> rows referencing this key. A gap means a ledger
                      row was pruned — it is shown rather than reconciled away.
                    </div>
                  ) : (
                    <p className={v.faint}>
                      The counter and the ledger agree. They are computed independently and are shown
                      apart so that a disagreement would be visible rather than assumed impossible.
                    </p>
                  )}
                  {usage.data.unpricedEvents > 0 && (
                    <p className={v.dim}>
                      {usage.data.unpricedEvents} call(s) on this key ran against an <strong>unpriced</strong>{" "}
                      agent. Those add <strong>nothing</strong> to the counter: a measured token count never
                      becomes an invented dollar, so this key&apos;s budget did not see them.
                    </p>
                  )}
                  <KV
                    rows={[
                      ["Key id", <span className={v.mono}>{usage.data.key.id}</span>],
                      [
                        "Owner",
                        names.userEmail.get(usage.data.key.userId) ?? shortId(usage.data.key.userId),
                      ],
                      [
                        "Pinned platform credential",
                        usage.data.key.upstreamCredentialId ? (
                          <span className={v.mono}>
                            {shortId(usage.data.key.upstreamCredentialId)} — the holder never sees it
                          </span>
                        ) : (
                          "none — the ordinary credential resolution applies"
                        ),
                      ],
                      ["Issued", new Date(usage.data.key.createdAt).toLocaleString()],
                      [
                        "Revoked",
                        usage.data.key.revokedAt
                          ? new Date(usage.data.key.revokedAt).toLocaleString()
                          : "not revoked",
                      ],
                    ]}
                  />
                  <p className={v.faint}>
                    The token itself is not here and cannot be. Only its sha256 was ever stored, and no
                    endpoint returns it — if it was lost, revoke this key and issue another.
                  </p>
                </div>
              )}
            </QueryGate>
          </Card>
        )}
      </div>

      {/* --- issuer-only settings ---------------------------------------- */}
      {editing && (
        <Card title={`Settings — ${editing.name}`}>
          <div className={v.stack}>
            <p className={v.dim}>
              The allow-list, budget and expiry are the <strong>issuer&apos;s</strong> settings. Owning a
              key lets you rename or revoke it — not raise its ceiling. A non-issuer, non-admin attempt is
              refused with <code>not_key_issuer</code>, and that refusal appears here verbatim.
            </p>
            <Field label="Name">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="vk-edit-name"
              />
            </Field>
            <label className={v.row}>
              <input
                type="checkbox"
                checked={editRestrict}
                onChange={(e) => setEditRestrict(e.target.checked)}
                data-testid="vk-edit-restrict"
              />
              <span>Restrict to specific agents / models</span>
            </label>
            {editRestrict && (
              <Field label="Allow-list — one entry per line" grow>
                <Textarea
                  rows={4}
                  value={editAllowList}
                  onChange={(e) => setEditAllowList(e.target.value)}
                  spellCheck={false}
                  data-testid="vk-edit-allowlist"
                />
              </Field>
            )}
            <div className={v.row}>
              <Field label="Lifetime budget (USD) — blank clears the cap">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editBudget}
                  onChange={(e) => setEditBudget(e.target.value)}
                  data-testid="vk-edit-budget"
                />
              </Field>
              <Field label="Expires — blank clears the expiry">
                <Input
                  type="datetime-local"
                  value={editExpires}
                  onChange={(e) => setEditExpires(e.target.value)}
                  data-testid="vk-edit-expires"
                />
              </Field>
            </div>
            <div className={v.row}>
              <Button
                variant="primary"
                disabled={act.busy}
                onClick={() => void saveEdit()}
                data-testid="vk-edit-save"
              >
                Save settings
              </Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmModal
        open={revoking !== null}
        title={revoking ? `Revoke '${revoking.name}'?` : ""}
        danger
        confirmLabel="Revoke key"
        body={
          <p>
            Every client holding this token stops working immediately. The key row, its spend and its audit
            trail are <strong>kept</strong> — revoking is not deleting — and a revoked key cannot be
            un-revoked. Issue a new one instead.
          </p>
        }
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
