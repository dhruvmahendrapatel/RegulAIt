/** Gate 1 (ADR-0025): a one-time password must be replaced before anything
 * else — the gateway 403s every non-self-service route until it is. */
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button, Field, Input } from "../../ui/kit";
import { Brand } from "./LoginPage";
import s from "./auth.module.css";

export default function ForcedPasswordChange() {
  const { refresh, signOut } = useSession();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("The two new-password fields don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "current_password_incorrect") {
        setError("The current (one-time) password is incorrect.");
      } else if (err instanceof ApiError && err.payload.error === "password_policy") {
        setError(err.payload.detail ?? "The new password doesn't meet the organization's policy.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.gate}>
      <main className={s.panel}>
        <Brand />
        <div className={s.notice}>
          Your password is one-time — set your own before continuing. Every other
          session for this account will be signed out.
        </div>
        {error && <div className={s.error} role="alert">{error}</div>}
        <form className={s.form} onSubmit={submit}>
          <Field label="Current (one-time) password">
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Set password & continue"}
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </form>
      </main>
    </div>
  );
}
