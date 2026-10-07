/**
 * Account — identity, password change and TOTP MFA self-service (ADR-0025),
 * plus per-user BYO model keys (ModelKeysCard). Reached from the topbar user
 * menu; ?section= deep-links (password | mfa | passkeys | keys | ai-policies). ADR-0182 A14 adds the AI policies section;
 * ADR-0186 A adds Passkeys.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { OwnSession } from "../../api/adminTypes";
import { ago } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, IdChip, Input, Table } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import ModelKeysCard from "./ModelKeysCard";
import PasskeysCard from "./PasskeysCard";
import { LiteracyDocumentList, useMyLiteracy } from "./AcknowledgeGate";
import v from "../views.module.css";
import s from "../auth/auth.module.css";

export default function AccountPage() {
  const { auth, refresh } = useSession();
  const [params] = useSearchParams();
  const section = params.get("section");
  const pwRef = useRef<HTMLDivElement>(null);
  const mfaRef = useRef<HTMLDivElement>(null);
  const passkeysRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const policiesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section === "password") pwRef.current?.scrollIntoView({ block: "start" });
    if (section === "mfa") mfaRef.current?.scrollIntoView({ block: "start" });
    if (section === "passkeys") passkeysRef.current?.scrollIntoView({ block: "start" });
    if (section === "sessions") sessionsRef.current?.scrollIntoView({ block: "start" });
    if (section === "keys") keysRef.current?.scrollIntoView({ block: "start" });
    if (section === "ai-policies") policiesRef.current?.scrollIntoView({ block: "start" });
  }, [section]);

  return (
    <>
      <PageHeader
        title="Account"
        sub="Your identity, how you sign in, and the provider keys your own requests run on."
      />
      <div className={v.stack}>
        <Card title="Identity">
          <div className={v.listRow}>
            <span className={v.faint} style={{ width: 100 }}>
              name
            </span>
            <span>{auth?.user?.displayName ?? "bootstrap operator"}</span>
          </div>
          <div className={v.listRow}>
            <span className={v.faint} style={{ width: 100 }}>
              email
            </span>
            <span>{auth?.user?.email ?? "—"}</span>
          </div>
          <div className={v.listRow}>
            <span className={v.faint} style={{ width: 100 }}>
              user id
            </span>
            <IdChip id={auth?.userId} />
          </div>
          <div className={v.listRow}>
            <span className={v.faint} style={{ width: 100 }}>
              role
            </span>
            <span>{auth?.isAdmin ? <Badge tone="primary">admin</Badge> : "member"}</span>
          </div>
          <div className={v.listRow}>
            <span className={v.faint} style={{ width: 100 }}>
              signed in via
            </span>
            <span className={v.mono}>{auth?.via ?? "—"}</span>
          </div>
        </Card>

        <div ref={pwRef}>
          <PasswordCard passwordSet={Boolean(auth?.passwordSet)} />
        </div>
        <div ref={mfaRef}>
          <MfaCard totpEnabled={Boolean(auth?.totpEnabled)} onChanged={() => void refresh()} />
        </div>
        {auth?.userId && (
          <div ref={passkeysRef} data-testid="account-passkeys">
            <PasskeysCard />
          </div>
        )}
        <div ref={sessionsRef}>
          <SessionsCard />
        </div>
        <div ref={keysRef}>
          <ModelKeysCard />
        </div>
        <div ref={policiesRef} data-testid="account-ai-policies">
          <AiPoliciesCard hasUser={Boolean(auth?.userId)} />
        </div>
      </div>
    </>
  );
}

/**
 * ADR-0182 A14 — the AI policies and trainings that apply to me, and acknowledging them. The same list the
 * acknowledgement interstitial shows; this page is never interrupted by it, so the way through is always here.
 */
function AiPoliciesCard(props: { hasUser: boolean }) {
  const q = useMyLiteracy(props.hasUser);
  const d = q.data;
  return (
    <Card
      title={
        <span className={v.rowTight}>
          AI policies
          {d && d.required && (d.current ? <Badge tone="ok">all acknowledged</Badge> : <Badge tone="warn">to acknowledge</Badge>)}
        </span>
      }
    >
      {!props.hasUser ? (
        <div className={v.faint}>The bootstrap identity is not a person and acknowledges nothing.</div>
      ) : q.isLoading ? (
        <div className={v.faint}>Loading…</div>
      ) : q.error || !d ? (
        // deliberately not role="alert": this card must never compete with the security forms above for the
        // page's one urgent announcement (a wrong password, a failed MFA step)
        <div className={v.row}>
          <span className={v.faint}>Your AI policies could not be loaded right now.</span>
          <Button size="sm" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className={v.stack}>
          <div className={v.faint}>
            Your organisation asks you to read and acknowledge these as one of its measures to support the
            development of AI literacy (Regulation (EU) 2024/1689, Article 4, as amended). An acknowledgement records
            that you read the version shown; it expires and is asked for again, and a new version (other than an
            editorial correction) needs a new acknowledgement.
            {d.exempt === "break_glass" ? " As a designated break-glass admin, your governed calls are not held for it." : ""}
          </div>
          <LiteracyDocumentList data={d} />
        </div>
      )}
    </Card>
  );
}

/**
 * ADR-0039 — the account-security session list: every live session for THIS
 * account (device label, where it is now, when it was last seen), with
 * per-session revoke and "sign out other devices". The device label is a
 * derived display string, never a security control.
 */
function SessionsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["account", "sessions"],
    queryFn: () => api.get<{ sessions: OwnSession[] }>("/auth/sessions"),
  });
  const sessions = q.data?.sessions ?? [];
  const others = sessions.filter((x) => !x.current);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(okMsg, "success");
      await qc.invalidateQueries({ queryKey: ["account", "sessions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className={v.rowTight}>
          Devices & sessions
          <Badge>{sessions.length} live</Badge>
        </span>
      }
    >
      {error && (
        <div className={v.errLine} role="alert" style={{ marginBottom: "var(--s1)" }}>
          {error}
        </div>
      )}
      <div className={v.stack}>
        <Table<OwnSession>
          columns={[
            {
              key: "device",
              header: "Device",
              render: (x) => (
                <span className={v.rowTight}>
                  {x.deviceLabel}
                  {x.current && <Badge tone="primary">this device</Badge>}
                </span>
              ),
            },
            {
              key: "ip",
              header: "IP",
              render: (x) => <span className={v.mono}>{x.lastSeenIp ?? x.ip ?? "—"}</span>,
            },
            { key: "signedIn", header: "Signed in", render: (x) => ago(x.createdAt) },
            { key: "seen", header: "Last seen", render: (x) => ago(x.lastSeenAt) },
            { key: "origin", header: "Via", render: (x) => <span className={v.mono}>{x.origin}</span> },
            {
              key: "actions",
              header: "",
              render: (x) =>
                x.current ? null : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.post(`/auth/sessions/${x.id}/revoke`),
                        "Session signed out (audited)",
                      )
                    }
                  >
                    Sign out
                  </Button>
                ),
            },
          ]}
          rows={sessions}
          rowKey={(x) => x.id}
          empty={<EmptyState title="No live sessions" body="Sessions appear here when you sign in from a browser." />}
        />
        <div className={v.row}>
          <span className={v.faint}>
            Don't recognize a session? Sign it out — it stops authenticating immediately, and every
            revocation is audited.
          </span>
          <span className={v.grow} />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || others.length === 0}
            onClick={() =>
              void run(
                () => api.post("/auth/sessions/revoke-others"),
                "All other devices were signed out (audited)",
              )
            }
          >
            Sign out other devices
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PasswordCard(props: { passwordSet: boolean }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("The two new-password fields don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      toast("Password changed — other sessions were signed out", "success");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "current_password_incorrect") {
        setError("The current password is incorrect.");
      } else if (err instanceof ApiError && err.payload.error === "password_policy") {
        setError(err.payload.detail ?? "The new password doesn't meet the organization's policy.");
      } else if (err instanceof ApiError && err.payload.error === "no_password_set") {
        setError("This account has no password yet — an admin must set an initial one-time password.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Password">
      {!props.passwordSet && (
        <div className={v.faint} style={{ marginBottom: "var(--s1)" }}>
          No password is set on this account — an admin can issue a one-time password; SSO and
          API-key sign-in keep working regardless.
        </div>
      )}
      {error && (
        <div className={v.errLine} role="alert" style={{ marginBottom: "var(--s1)" }}>
          {error}
        </div>
      )}
      <form onSubmit={submit} className={v.row} style={{ alignItems: "flex-end" }}>
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </Button>
      </form>
      <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
        Changing your password signs out every other session for this account.
      </div>
    </Card>
  );
}

function MfaCard(props: { totpEnabled: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.payload.detail
          ? err.payload.detail
          : err instanceof ApiError && err.payload.error === "invalid_code"
            ? "That code wasn't accepted."
            : err instanceof ApiError && err.payload.error === "invalid_password_or_code"
              ? "Password or code wasn't accepted — disabling MFA re-proves both factors."
              : err instanceof Error
                ? err.message
                : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className={v.rowTight}>
          Two-factor authentication
          {props.totpEnabled ? <Badge tone="ok">enabled</Badge> : <Badge>off</Badge>}
        </span>
      }
    >
      {error && (
        <div className={v.errLine} role="alert" style={{ marginBottom: "var(--s1)" }}>
          {error}
        </div>
      )}
      {props.totpEnabled ? (
        <div className={v.row} style={{ alignItems: "flex-end" }}>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Authenticator code">
            <Input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button
            variant="danger"
            disabled={busy || !password || code.length !== 6}
            onClick={() =>
              void run(async () => {
                await api.post("/auth/totp/disable", { password, code });
                toast("MFA disabled", "success");
                setPassword("");
                setCode("");
                props.onChanged();
              })
            }
          >
            Disable MFA
          </Button>
        </div>
      ) : !secret ? (
        <>
          <div className={v.dim} style={{ marginBottom: "var(--s1)" }}>
            TOTP via any authenticator app. The secret is stored encrypted and shown exactly once.
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setSecret(
                  await api.post<{ secret: string; otpauthUri: string }>("/auth/totp/enroll"),
                );
              })
            }
          >
            {busy ? "Generating…" : "Enroll an authenticator"}
          </Button>
        </>
      ) : (
        <div className={v.stack}>
          <div className={s.secretBox}>
            <strong>Shown exactly once.</strong>
            <span>Add this secret to your authenticator app:</span>
            <span className={s.secretValue}>{secret.secret}</span>
            <CodeBlock maxHeight="80px">{secret.otpauthUri}</CodeBlock>
          </div>
          <div className={v.row} style={{ alignItems: "flex-end" }}>
            <Field label="Code from your authenticator">
              <Input
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy || code.length !== 6}
              onClick={() =>
                void run(async () => {
                  await api.post("/auth/totp/activate", { code });
                  toast("MFA enabled", "success");
                  setSecret(null);
                  setCode("");
                  props.onChanged();
                })
              }
            >
              Activate
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
