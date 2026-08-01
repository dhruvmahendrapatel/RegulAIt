/**
 * Your model keys — per-user BYO credential self-service (migration 0017's
 * self-service endpoints, the developer half of ADR-0024's key-custody rung).
 *
 * Two rules govern everything in here:
 *
 * 1. **A stored secret is never displayed or echoed.** The backend keeps
 *    AES-256-GCM ciphertext and no endpoint returns plaintext; this card only
 *    ever shows provider + presence + base URL + when it was set. The input is
 *    cleared the moment the write succeeds and its value never enters app
 *    state beyond the keystroke that typed it.
 *
 * 2. **Key custody is stated, not discovered by failing.** With
 *    `interception_settings.key_custody_enforced` ON (ADR-0024 §3) the org
 *    holds the vendor keys: `POST /v1/users/:id/model-credentials` answers
 *    409 and dispatch skips stored user rows entirely. When we KNOW custody is
 *    on we explain it and withdraw the control rather than offering one that
 *    will fail, and stored rows are labelled inert — never "in use".
 *
 * Knowing it is the subtle part: `GET /v1/interception/settings` is admin-only
 * (deliberately — writing the posture is not a developer's business), so an
 * admin reads the flag up front while a developer can only learn it from the
 * 409. So a developer is never TOLD their key is being used: presence is
 * reported as "stored", and the honest answer to "is it actually serving my
 * calls?" is the measured `Key used` column on Spend & savings, which this
 * card links to.
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { ago } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  SkeletonBlock,
  Table,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

/** mirrors createModelCredentialSchema's provider enum in @regulait/shared */
const PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;

interface UserCredential {
  id?: string;
  provider: string;
  baseUrl?: string | null;
  createdAt: string;
}

interface InterceptionSettingsResponse {
  settings: { keyCustodyEnforced?: boolean };
}

export default function ModelKeysCard() {
  const { auth } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const userId = auth?.userId ?? null;

  const [provider, setProvider] = useState<string>(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  /** set when the server refuses a write with 409 key_custody_enforced — the
   * only way a non-admin can learn the posture (the settings read is admin) */
  const [custodyRefused, setCustodyRefused] = useState(false);

  // the same query key ChatPage uses for its "your key vs platform" badge, so
  // adding or removing a key here updates that badge without a reload
  const credsQ = useQuery({
    queryKey: ["my-credentials", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<{ credentials: UserCredential[] }>(`/v1/users/${userId}/model-credentials`),
  });

  // admins can read the posture up front; for everyone else it stays unknown
  // until the server says otherwise, and we never guess
  const custodyQ = useQuery({
    queryKey: ["interception-settings"],
    enabled: Boolean(auth?.isAdmin),
    queryFn: () => api.get<InterceptionSettingsResponse>("/v1/interception/settings"),
  });
  const custodyEnforced =
    custodyRefused || custodyQ.data?.settings?.keyCustodyEnforced === true;

  const credentials = credsQ.data?.credentials ?? [];
  const have = new Set(credentials.map((c) => c.provider));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["my-credentials", userId] });
    void qc.invalidateQueries({ queryKey: ["provider-status"] });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!apiKey.trim()) {
      setError("A key is required.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/v1/users/${userId}/model-credentials`, {
        provider,
        apiKey: apiKey.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey("");
      setBaseUrl("");
      toast(
        have.has(provider)
          ? `${provider} key replaced — stored encrypted, never shown again`
          : `${provider} key saved — stored encrypted, never shown again`,
        "success",
      );
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "key_custody_enforced") {
        // stop offering a control that cannot work, and say why
        setCustodyRefused(true);
        setApiKey("");
        setError(null);
      } else if (err instanceof ApiError && err.payload.error === "no_data_key") {
        setError(
          "This deployment has no encryption key configured, so nothing can be stored securely — an admin must set REGULAIT_DATA_KEY.",
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: string) => {
    try {
      await api.del(`/v1/users/${userId}/model-credentials/${encodeURIComponent(p)}`);
      toast(`${p} key removed`, "success");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  if (auth && !userId) {
    return (
      <Card title="Your model keys">
        <EmptyState
          title="This session has no user identity"
          body="You are signed in with the bootstrap token rather than as a user, and BYO keys belong to a user. Sign in as a user to manage your own keys."
        />
      </Card>
    );
  }

  return (
    <Card
      title={
        <span className={v.rowTight}>
          Your model keys
          {custodyEnforced && <Badge tone="warn">key custody enforced</Badge>}
        </span>
      }
    >
      <div className={v.dim} style={{ marginBottom: "var(--s2)" }}>
        Bring your own provider key so your requests run on your account instead of the
        organisation&apos;s. A key is encrypted at rest the moment it arrives and is never
        returned by any endpoint — not to you, not to an admin — so this page can only ever show
        which providers you have a key for.
      </div>

      {custodyEnforced && <CustodyNotice isAdmin={Boolean(auth?.isAdmin)} />}

      {credsQ.isLoading ? (
        <SkeletonBlock lines={3} />
      ) : (
        <Table<UserCredential>
          columns={[
            { key: "provider", header: "Provider", render: (c) => c.provider },
            {
              key: "state",
              header: "Key",
              render: () =>
                custodyEnforced ? (
                  <Badge tone="warn" title="Stored, but not used while key custody is enforced">
                    stored · inert
                  </Badge>
                ) : (
                  <Badge tone="ok" title="A key is stored for this provider; its value is never shown">
                    stored
                  </Badge>
                ),
            },
            {
              key: "baseUrl",
              header: "Endpoint",
              render: (c) => c.baseUrl ?? <span className={v.faint}>provider default</span>,
            },
            { key: "added", header: "Set", render: (c) => ago(c.createdAt) },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (c) => (
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Remove your ${c.provider} key`}
                  onClick={() => setRemoving(c.provider)}
                >
                  Remove
                </Button>
              ),
            },
          ]}
          rows={credentials}
          rowKey={(c) => c.provider}
          empty={
            <EmptyState
              title="No keys of your own"
              body="Your requests use the organisation's platform credential when one is configured for the provider."
            />
          }
        />
      )}

      {!custodyEnforced && (
        <>
          <hr className={v.divider} />
          <form onSubmit={save} className={v.row} style={{ alignItems: "flex-end" }}>
            <Field label="Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {have.has(p) ? " — replace" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="API key" grow>
              <Input
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Field>
            <Field label="Base URL">
              <Input
                placeholder="optional override"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : have.has(provider) ? "Replace key" : "Save key"}
            </Button>
          </form>
          {error && (
            <div className={v.errLine} role="alert" style={{ marginTop: "var(--s1)" }}>
              {error}
            </div>
          )}
          <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
            Saving the same provider twice rotates the stored key in place. Your own key takes
            precedence over the organisation&apos;s for your requests — unless your organisation
            enforces key custody, in which case stored keys stay inert. Which credential actually
            served any given call is recorded per call: see the <em>Key used</em> column on{" "}
            <Link to="/spend">Spend &amp; savings</Link>.
          </div>
        </>
      )}

      <ConfirmModal
        open={removing !== null}
        title={`Remove your ${removing} key?`}
        body={
          <span>
            The stored ciphertext is deleted. Your requests fall back to the organisation&apos;s
            platform credential for {removing}, or start being refused if there isn&apos;t one.
          </span>
        }
        danger
        confirmLabel="Remove key"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const p = removing;
          setRemoving(null);
          if (p) void remove(p);
        }}
      />
    </Card>
  );
}

/** ADR-0024 §3 in the developer's words — why the control is gone, what
 * happens to what is already stored, and who can change it. */
function CustodyNotice(props: { isAdmin: boolean }) {
  return (
    <div
      role="note"
      className={v.dim}
      style={{
        border: "1px solid var(--border)",
        background: "var(--warn-soft)",
        color: "var(--warn-soft-text)",
        borderRadius: "var(--radius-md)",
        padding: "var(--s2)",
        marginBottom: "var(--s2)",
      }}
    >
      <strong>This deployment enforces key custody.</strong> The organisation holds the vendor
      keys and developers hold only RegulAIt keys, so per-user BYO credentials cannot be added or
      replaced here — the attempt is refused and audited. Every dispatch of yours resolves to the
      organisation&apos;s platform credential for the provider.
      <div style={{ marginTop: "var(--s1)" }}>
        Anything already stored below is <strong>kept, not deleted, and inert</strong> — it is
        skipped entirely at dispatch and would become live again exactly as stored if an admin
        lifted custody. Nothing here is using it today.
        {props.isAdmin ? (
          <>
            {" "}
            You are an admin: the toggle is <Link to="/admin/client-access">Client access →
            keyCustodyEnforced</Link>.
          </>
        ) : (
          " An admin can lift it in Client access."
        )}
      </div>
    </div>
  );
}
