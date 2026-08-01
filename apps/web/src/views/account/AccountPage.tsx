/**
 * Account — identity, password change and TOTP MFA self-service (ADR-0025),
 * plus per-user BYO model keys (ModelKeysCard). Reached from the topbar user
 * menu; ?section= deep-links (password | mfa | keys).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, Field, IdChip, Input } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import ModelKeysCard from "./ModelKeysCard";
import v from "../views.module.css";
import s from "../auth/auth.module.css";

export default function AccountPage() {
  const { auth, refresh } = useSession();
  const [params] = useSearchParams();
  const section = params.get("section");
  const pwRef = useRef<HTMLDivElement>(null);
  const mfaRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section === "password") pwRef.current?.scrollIntoView({ block: "start" });
    if (section === "mfa") mfaRef.current?.scrollIntoView({ block: "start" });
    if (section === "keys") keysRef.current?.scrollIntoView({ block: "start" });
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
        <div ref={keysRef}>
          <ModelKeysCard />
        </div>
      </div>
    </>
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
