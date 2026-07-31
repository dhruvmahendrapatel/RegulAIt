/** Gate 1 (ADR-0025): a one-time password must be replaced before anything
 * else — the gateway 403s every non-self-service route until it is. */
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button, Field, Input } from "../../ui/kit";
import { Brand } from "./LoginPage";
import s from "./auth.module.css";

export default function ForcedPasswordChange() {
  const { auth, refresh, signOut } = useSession();
  // ADR-0028: the SERVER says whether the current password is required — the
  // rule lives in one place and this view only obeys it. Anything other than
  // an explicit `false` means required (fail closed).
  const requiresCurrent = auth?.passwordChangeRequiresCurrent !== false;
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
      await api.post("/auth/change-password", {
        // omitted entirely when the server said it isn't required
        ...(requiresCurrent ? { currentPassword } : {}),
        newPassword,
      });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "current_password_incorrect") {
        setError("The current (one-time) password is incorrect.");
      } else if (err instanceof ApiError && err.payload.error === "current_password_required") {
        setError("This account's current password is required to set a new one.");
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
        {/* Name the account. An admin-issued one-time password lands the user
         * straight here, often on a shared machine or a second account — a
         * password form that never says WHOSE password it is sets the wrong one. */}
        <div className={s.identity}>
          Setting the password for{" "}
          <strong>{auth?.user?.email ?? "this account"}</strong>
          {auth?.user?.displayName ? ` (${auth.user.displayName})` : ""}
        </div>
        <div className={s.notice}>
          {auth?.passwordSet === false
            ? "This account has no password yet — set one before continuing."
            : "Your password is one-time — set your own before continuing."}{" "}
          Every other session for this account will be signed out.
        </div>
        {/* ADR-0028: a user who signed in with an API key onto a one-time /
         * passwordless account was never told a current password. Asking for
         * one locked them out of the whole product, so the server drops the
         * requirement in exactly that case and the field goes away with it. */}
        {!requiresCurrent && (
          <div className={s.notice}>
            You signed in with an API key, so you can set a password directly.
          </div>
        )}
        {error && <div className={s.error} role="alert">{error}</div>}
        <form className={s.form} onSubmit={submit}>
          {requiresCurrent && (
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
          )}
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              autoFocus={!requiresCurrent}
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
