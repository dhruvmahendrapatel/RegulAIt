/** Gate 2 (ADR-0025): org-mandated TOTP enrollment. Enroll returns the secret
 * exactly once; activate proves the authenticator before the gate opens. */
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import StepUpDialog from "../../stepup/StepUpDialog";
import { withStepUp } from "../../stepup/stepUp";
import { useSession } from "../../session/SessionContext";
import { Button, Field, Input } from "../../ui/kit";
import { TotpQrCode } from "../../ui/TotpQrCode";
import { Brand } from "./LoginPage";
import s from "./auth.module.css";

export default function ForcedMfaEnroll() {
  const { auth, refresh, signOut } = useSession();
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enroll = async () => {
    setError(null);
    setBusy(true);
    try {
      // ADR-0186 A: an account that already has a way to step up proves it before adding an authenticator
      setSecret(await withStepUp(async (h) => (await api.postWithHeaders<{ secret: string; otpauthUri: string }>("/auth/totp/enroll", {}, h)).body));
    } catch (err) {
      setError(
        err instanceof ApiError && err.payload.detail
          ? err.payload.detail
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/totp/activate", { code });
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.payload.error === "invalid_code"
          ? "That code wasn't accepted — check the authenticator and try the next one."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.gate}>
      {/* the step-up prompt: an account with a passkey or SSO identity proves it before adding an authenticator */}
      <StepUpDialog />
      <main className={s.panel}>
        <Brand />
        {/* Same reason as the password gate: an authenticator entry is bound to
         * an identity forever, so the account must be named before enrolling. */}
        <div className={s.identity}>
          Enrolling two-factor for{" "}
          <strong>{auth?.user?.email ?? "this account"}</strong>
          {auth?.user?.displayName ? ` (${auth.user.displayName})` : ""}
        </div>
        <div className={s.notice}>
          Your organization requires two-factor authentication. Enroll an
          authenticator app to continue.
        </div>
        {error && <div className={s.error} role="alert">{error}</div>}
        {!secret ? (
          <Button variant="primary" onClick={() => void enroll()} disabled={busy}>
            {busy ? "Generating…" : "Generate enrollment secret"}
          </Button>
        ) : (
          <div className={s.form}>
            <div className={s.secretBox}>
              <strong>Shown exactly once.</strong>
              <TotpQrCode secret={secret.secret} otpauthUri={secret.otpauthUri} uriMaxHeight="90px" />
            </div>
            <Field label="Code from your authenticator">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
              />
            </Field>
            <Button variant="primary" onClick={() => void activate()} disabled={busy || code.length !== 6}>
              {busy ? "Activating…" : "Activate MFA & continue"}
            </Button>
          </div>
        )}
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </main>
    </div>
  );
}
