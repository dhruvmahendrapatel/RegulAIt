/**
 * ADR-0030 — set, change or clear a username. Used on the Account page (the
 * person's own, through `POST /auth/username`, only while the org allows
 * self-service) and on a user's Lifecycle tab (any user, through
 * `PUT /v1/users/:id/username`). The caller passes the write; this form
 * validates the shape first and shows the gateway's refusal under the field.
 */
import { useId, useState } from "react";
import { Button, Field, Input } from "../../ui/kit";
import { normaliseUsername, USERNAME_RULE, usernameRefusal } from "./username";
import v from "../views.module.css";

export function UsernameForm(props: {
  current: string | null;
  /** the write; resolves when stored */
  save: (username: string | null) => Promise<void>;
  label?: string;
  /** shown instead of the controls when writes are not allowed */
  lockedReason?: string | null;
  testId?: string;
}) {
  const [draft, setDraft] = useState(props.current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ruleId = useId();
  const errorId = useId();
  const parsed = normaliseUsername(draft);
  const unchanged = parsed.ok && parsed.value === props.current;
  const run = async (next: string | null) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await props.save(next);
      setSaved(next === null ? "Username cleared." : `Username set to ${next}.`);
      setDraft(next ?? "");
    } catch (err) {
      setError(usernameRefusal(err));
    } finally {
      setBusy(false);
    }
  };
  const label = props.label ?? "Username";
  if (props.lockedReason) {
    return (
      <div className={v.stack} data-testid={props.testId}>
        <div className={v.listRow}>
          <span className={v.faint} style={{ width: 100 }}>
            username
          </span>
          <span className={v.mono}>{props.current ?? "none (sign in with email)"}</span>
        </div>
        <p className={v.faint}>{props.lockedReason}</p>
      </div>
    );
  }
  return (
    <form
      className={v.stack}
      data-testid={props.testId}
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !parsed.ok || unchanged) return;
        void run(parsed.value);
      }}
    >
      <div className={v.row} style={{ alignItems: "flex-end" }}>
        <Field label={label}>
          <Input
            value={draft}
            autoComplete="username"
            maxLength={64}
            aria-describedby={error ? `${ruleId} ${errorId}` : ruleId}
            aria-invalid={draft !== "" && !parsed.ok}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <Button type="submit" size="sm" disabled={busy || !parsed.ok || unchanged}>
          {busy ? "Saving…" : props.current ? "Change username" : "Set username"}
        </Button>
        {props.current ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void run(null)}>
            Clear username
          </Button>
        ) : null}
      </div>
      <p className={v.faint} id={ruleId}>
        {draft !== "" && !parsed.ok ? parsed.problem : USERNAME_RULE} A username is a second way to sign in; it is never a password.
      </p>
      {error && (
        <p className={v.errLine} role="alert" id={errorId}>
          {error}
        </p>
      )}
      {saved && <p role="status">{saved}</p>}
    </form>
  );
}
