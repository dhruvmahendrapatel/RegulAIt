/**
 * Sign-in (ADR-0025): email + password (uniform errors — never an
 * account-existence oracle), the TOTP second step, SSO provider buttons, and
 * the details-toggled API-key exchange for key-first users. On success the
 * router returns the user to wherever the 401 interrupted them.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { AuthMeResponse, LoginResponse, OidcProvidersResponse } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { Button, Field, Input } from "../../ui/kit";
import s from "./auth.module.css";

export function Brand() {
  return (
    <div className={s.brand}>
      <span className={s.brandWord}>
        regul<em>ai</em>t
      </span>
      <span className={s.brandTag}>governed</span>
    </div>
  );
}

export default function LoginPage() {
  const { auth, applyAuth, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [code, setCode] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const providers = useQuery({
    queryKey: ["oidc-providers"],
    queryFn: () => api.get<OidcProvidersResponse>("/auth/oidc/providers"),
    staleTime: 60_000,
  });

  // already signed in (e.g. back-button to /login) → straight through
  useEffect(() => {
    if (auth?.userId || auth?.isAdmin) navigate(returnTo, { replace: true });
  }, [auth, navigate, returnTo]);

  const finish = async () => {
    const a = await refresh();
    if (a) {
      applyAuth(a);
      navigate(returnTo, { replace: true });
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<LoginResponse>("/auth/login", { email, password });
      if (r.mfaRequired && r.pendingToken) {
        setPendingToken(r.pendingToken);
        return;
      }
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "sso_required") {
        setSsoOnly(true);
        setError("Password sign-in is disabled for this organization — use single sign-on below.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Email or password is incorrect.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post<LoginResponse>("/auth/mfa/verify", { pendingToken, code });
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "invalid_code") {
        setError("That code wasn't accepted — codes are single-use and expire every 30 seconds.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("The sign-in window expired — start again.");
        setPendingToken(null);
        setCode("");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post<LoginResponse>("/auth/login-with-key", { apiKey });
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(
          err.payload.error === "user_disabled"
            ? "This account has been deactivated — an admin can reactivate it."
            : "That key wasn't accepted.",
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const ssoButtons = (providers.data?.providers ?? []).map((p) => (
    <Button
      key={p.id}
      onClick={() => {
        // server-side returnTo whitelist is /app|/admin (phase 2 adds /ui) —
        // the session cookie is set either way, so /ui works after callback.
        window.location.href = `/auth/oidc/${p.id}/start?returnTo=/app`;
      }}
    >
      Continue with {p.name}
    </Button>
  ));

  if (pendingToken) {
    return (
      <div className={s.gate}>
        <main className={s.panel}>
          <Brand />
          <p className={s.sub}>
            Two-factor step — enter the 6-digit code from your authenticator app.
          </p>
          {error && <div className={s.error} role="alert">{error}</div>}
          <form className={s.form} onSubmit={submitTotp}>
            <Field label="Authenticator code">
              <Input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
              />
            </Field>
            <Button variant="primary" type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingToken(null);
                setCode("");
                setError(null);
              }}
            >
              Back to sign-in
            </Button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className={s.gate}>
      <main className={s.panel}>
        <Brand />
        <p className={s.sub}>Sign in to your governed workspace.</p>
        {error && <div className={s.error} role="alert">{error}</div>}
        {!ssoOnly && (
          <form className={s.form} onSubmit={submitPassword}>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </Field>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
        {ssoButtons.length > 0 && (
          <>
            <div className={s.divider}>or</div>
            <div className={s.ssoRow}>{ssoButtons}</div>
          </>
        )}
        <details className={s.details}>
          <summary>Sign in with an API key instead</summary>
          <form className={`${s.detailsBody} ${s.form}`} onSubmit={submitKey}>
            <p className={s.sub}>
              Exchanges your RegulAIt API key for a browser session — the key never
              lives in web storage.
            </p>
            <Field label="API key">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="rgl_…"
              />
            </Field>
            <Button type="submit" disabled={busy || !apiKey.trim()}>
              Exchange key for a session
            </Button>
          </form>
        </details>
      </main>
    </div>
  );
}
