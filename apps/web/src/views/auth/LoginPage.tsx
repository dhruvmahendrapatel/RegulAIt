/**
 * Sign-in (ADR-0025, ADR-0030, ADR-0174).
 *
 * What the page offers comes from `GET /auth/sign-in-options` and nothing else:
 *
 *  - "Continue with Microsoft / Google / GitHub" — one per upstream IdP the
 *    bundled broker (Keycloak) offers; each passes the broker an IdP hint;
 *  - "Single sign-on" — the organisation's own enterprise IdPs (OIDC or SAML);
 *  - "Sign in with email" — the local account form (email OR username +
 *    password, uniform errors — never an account-existence oracle), with the
 *    TOTP second step. When the org restricts local sign-in to break-glass
 *    admins, the form sits behind an "Administrator sign-in" disclosure;
 *  - the API-key exchange for key-first users.
 *
 * When the options cannot be read (an older gateway, a network blip), the page
 * falls back to the email form — the one path every deployment has.
 *
 * `?link=pending` is the ADR-0174 §5 account-link step: a federated identity
 * matched an existing account that has a local credential, so the person
 * proves that account here (password, plus authenticator code if they use one)
 * before the two are linked. The field labels of the email form are kept
 * exactly as before — every browser spec signs in through them.
 *
 * The identifier field is deliberately NOT type="email": forcing email format
 * in the browser is exactly what made `dhruv` unusable before the server ever
 * saw it. Validation of the identifier belongs to the server.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { RefusalGuidance } from "../../api/refusals";
import type {
  BrokerIdp,
  LinkPendingResponse,
  LoginRequestBody,
  LoginResponse,
  SignInOptionsResponse,
} from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { Endorsement, Lockup } from "../../ui/Brand";
import { Button, Field, Input } from "../../ui/kit";
import { RefusalNotice } from "../../ui/RefusalNotice";
import { Logo } from "../../ui/logos/Logo";
import s from "./auth.module.css";

/** the lockup every auth gate opens with (also used by the forced-change and
 * forced-MFA gates) */
export function Brand() {
  return (
    <div className={s.brand}>
      <Lockup descriptor="governed" markSize={30} />
    </div>
  );
}

const BROKER_LABEL: Record<BrokerIdp, string> = {
  microsoft: "Microsoft",
  google: "Google",
  github: "GitHub",
};

/** read the options defensively: anything that is not the documented shape
 * (an older gateway, a stub) degrades to "email only" rather than to a blank
 * page */
function normalizeOptions(raw: unknown): SignInOptionsResponse {
  const fallback: SignInOptionsResponse = {
    broker: null,
    enterprise: [],
    local: { mode: "enabled", emailForm: true },
    apiKeyExchange: true,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Partial<SignInOptionsResponse>;
  const known: BrokerIdp[] = ["microsoft", "google", "github"];
  const broker =
    r.broker && typeof r.broker.providerId === "string" && Array.isArray(r.broker.idps)
      ? { ...r.broker, idps: known.filter((k) => r.broker!.idps.includes(k)) }
      : null;
  const enterprise = Array.isArray(r.enterprise)
    ? r.enterprise.filter((e) => e && typeof e.id === "string" && typeof e.name === "string" && (e.protocol === "oidc" || e.protocol === "saml"))
    : [];
  const mode = r.local?.mode === "break_glass_only" || r.local?.mode === "sso_only" ? r.local.mode : "enabled";
  return {
    broker: broker && broker.idps.length > 0 ? broker : null,
    enterprise,
    local: { mode, emailForm: mode === "enabled" },
    apiKeyExchange: r.apiKeyExchange !== false,
  };
}

function ProviderLink(props: { href: string; logo?: BrokerIdp; children: ReactNode }) {
  return (
    <a className={s.providerBtn} href={props.href}>
      {props.logo ? (
        <Logo name={props.logo} label="" size={20} className={s.providerLogo} />
      ) : (
        <span className={s.providerGlyph} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
      )}
      <span className={s.providerText}>{props.children}</span>
    </a>
  );
}

export default function LoginPage() {
  const { auth, applyAuth, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";
  const linkMode = new URLSearchParams(location.search).get("link") === "pending";
  // ADR-0174 (security review): a SAML sign-in the organisation's MFA policy
  // holds at the TOTP step. Its pending token is an HttpOnly cookie the
  // gateway set — the page never sees it, it just asks for the code.
  const [samlStepUp, setSamlStepUp] = useState(
    () => new URLSearchParams(location.search).get("mfa") === "pending",
  );

  // ADR-0030: one field, either namespace — an email address or a username
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [code, setCode] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADR-0183 2.3: a refused key whose owner must enrol TOTP says so, with the link
  const [guidance, setGuidance] = useState<RefusalGuidance | null>(null);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const ssoListId = useId();
  const titleId = useId();

  const optionsQ = useQuery({
    queryKey: ["sign-in-options"],
    queryFn: () => api.get<unknown>("/auth/sign-in-options"),
    staleTime: 60_000,
    retry: false,
  });
  const options = normalizeOptions(optionsQ.data);

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
      // ADR-0030 graceful degradation: an email keeps riding the pre-0047
      // `email` field (which every gateway understands), and only a username
      // needs the new `identifier` field.
      const value = identifier.trim();
      const body: LoginRequestBody = value.includes("@")
        ? { email: value, password }
        : { identifier: value, password };
      const r = await api.post<LoginResponse>("/auth/login", body);
      if (r.mfaRequired && r.pendingToken) {
        setPendingToken(r.pendingToken);
        return;
      }
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "sso_required") {
        setSsoOnly(true);
        setError("Password sign-in is disabled for this organization — use single sign-on.");
      } else if (err instanceof ApiError && err.payload.error === "local_sign_in_disabled") {
        setError("Email sign-in is reserved for break-glass administrators here — use single sign-on.");
      } else if (err instanceof ApiError && err.status === 401) {
        // deliberately one message for every failure mode — the server's
        // uniform 401 is not an account-existence oracle and neither is this
        setError("Email/username or password is incorrect.");
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
      await api.post<LoginResponse>("/auth/mfa/verify", pendingToken ? { pendingToken, code } : { code });
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "invalid_code") {
        setError("That code wasn't accepted — codes are single-use and expire every 30 seconds.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("The sign-in window expired — start again.");
        setPendingToken(null);
        setSamlStepUp(false);
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
    setGuidance(null);
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
      } else if (err instanceof ApiError && err.guidance) {
        setGuidance(err.guidance);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (linkMode) return <LinkAccount onDone={finish} />;

  if (pendingToken || samlStepUp) {
    return (
      <div className={s.gate}>
        <main className={s.panel} aria-labelledby={titleId}>
          <Brand />
          <h1 id={titleId} className={s.title}>Two-step verification</h1>
          <p className={s.sub}>
            {samlStepUp && !pendingToken
              ? "Your organization requires a second factor. Enter the 6-digit code from your authenticator app to finish signing in."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
          {/* which identity this challenge belongs to — matters when several
           * accounts share an authenticator app */}
          {identifier && (
            <div className={s.identity}>
              Signing in as <strong>{identifier}</strong>
            </div>
          )}
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
                setSamlStepUp(false);
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

  const broker = options.broker;
  const enterprise = options.enterprise;
  const hasFederated = Boolean(broker) || enterprise.length > 0;
  const showEmailForm = !ssoOnly && options.local.mode === "enabled";
  const breakGlass = !ssoOnly && options.local.mode === "break_glass_only";

  const keyForm = (
    <form className={`${s.detailsBody} ${s.form}`} onSubmit={submitKey}>
      <p className={s.sub}>
        Exchanges your regulAIt API key for a browser session — the key never lives in web storage.
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
  );

  const emailForm = (
    <form className={s.form} onSubmit={submitPassword}>
      <Field label="Email or username">
        <Input
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={!hasFederated}
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="you@company.com or dhruv"
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
  );

  return (
    <div className={s.gate}>
      <main className={s.panel} aria-labelledby={titleId}>
        <Brand />
        <div>
          <h1 id={titleId} className={s.title}>Sign in</h1>
          <p className={s.sub}>Welcome to your governed AI workspace.</p>
        </div>
        {error && <div className={s.error} role="alert">{error}</div>}
        <RefusalNotice guidance={guidance} />

        {hasFederated && (
          <div className={s.providers}>
            {broker?.idps.map((idp) => (
              <ProviderLink
                key={idp}
                logo={idp}
                href={`/auth/oidc/${encodeURIComponent(broker.providerId)}/login?idp=${idp}&returnTo=/app`}
              >
                Continue with {BROKER_LABEL[idp]}
              </ProviderLink>
            ))}
            {enterprise.length > 0 && (
              <>
                <button
                  type="button"
                  className={s.providerBtn}
                  aria-expanded={ssoOpen}
                  aria-controls={ssoListId}
                  onClick={() => setSsoOpen((v) => !v)}
                >
                  <span className={s.providerGlyph} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6" />
                    </svg>
                  </span>
                  <span className={s.providerText}>Single sign-on</span>
                  <span className={s.chevron} aria-hidden="true">{ssoOpen ? "▴" : "▾"}</span>
                </button>
                <div id={ssoListId} hidden={!ssoOpen} className={s.ssoList}>
                  <p className={s.hint}>Choose your organization’s identity provider.</p>
                  {enterprise.map((p) => (
                    <ProviderLink
                      key={`${p.protocol}:${p.id}`}
                      href={`/auth/${p.protocol}/${encodeURIComponent(p.id)}/start?returnTo=/app`}
                    >
                      Continue with {p.name}
                    </ProviderLink>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {hasFederated && (showEmailForm || breakGlass) && <div className={s.divider}>or</div>}

        {showEmailForm && (
          // a plain group, NOT a labelled region: a region named "Sign in with
          // email" would answer getByLabel("Email") alongside the input, and
          // every browser spec signs in through that selector
          <div className={s.section}>
            <h2 className={s.sectionTitle}>Sign in with email</h2>
            {emailForm}
          </div>
        )}

        {breakGlass && (
          <details className={s.details}>
            <summary>Administrator sign-in (break-glass)</summary>
            <div className={s.detailsBody}>
              <p className={s.sub}>
                Email sign-in is reserved for designated break-glass administrators. Everyone else signs in
                with single sign-on above.
              </p>
              {emailForm}
              {/* the API-key exchange is closed to everyone but the break-glass
               * admins (and the operator's bootstrap token) in this mode, so it
               * lives here rather than as a general option */}
              {!options.apiKeyExchange && (
                <details className={s.details}>
                  <summary>Break-glass administrator API key</summary>
                  {keyForm}
                </details>
              )}
            </div>
          </details>
        )}

        {options.apiKeyExchange && (
          <details className={s.details}>
            <summary>Sign in with an API key instead</summary>
            {keyForm}
          </details>
        )}
        <footer className={s.footer}>
          <Endorsement />
        </footer>
      </main>
    </div>
  );
}

/**
 * ADR-0174 §5 — the account-link step. The identity provider vouched for an
 * email address that already belongs to an account with its own password, so
 * that account must be proven here before the two are linked. The link request
 * rides an HttpOnly cookie the gateway set; nothing about it is in the URL.
 */
function LinkAccount(props: { onDone: () => Promise<void> }) {
  const navigate = useNavigate();
  const titleId = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useQuery({
    queryKey: ["link-pending"],
    queryFn: () => api.get<LinkPendingResponse>("/auth/link/pending"),
    retry: false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post<LoginResponse>("/auth/link/confirm", code ? { password, code } : { password });
      await props.onDone();
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "no_pending_link") {
        setError("This link request expired — sign in with your identity provider again.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Password or code is incorrect.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const back = () => navigate("/login", { replace: true });

  return (
    <div className={s.gate}>
      <main className={s.panel} aria-labelledby={titleId}>
        <Brand />
        <h1 id={titleId} className={s.title}>Link your account</h1>
        {pending.isLoading ? (
          <p className={s.sub}>Checking your sign-in…</p>
        ) : pending.data ? (
          <>
            <p className={s.sub}>
              <strong>{pending.data.provider}</strong> confirmed <strong>{pending.data.email}</strong>, which already
              has a regulAIt account with its own password. Confirm it’s you once to link them — after that,
              {" "}{pending.data.provider} signs you straight in.
            </p>
            {error && <div className={s.error} role="alert">{error}</div>}
            <form className={s.form} onSubmit={submit}>
              <Field label="Your regulAIt password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Authenticator code (if you use one)">
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                />
              </Field>
              <Button variant="primary" type="submit" disabled={busy || !password}>
                {busy ? "Linking…" : "Link and continue"}
              </Button>
            </form>
            <p className={s.hint}>
              Don’t know the password? An administrator can approve the link instead — then sign in with{" "}
              {pending.data.provider} again.
            </p>
            <Button variant="ghost" onClick={back}>
              Back to sign-in
            </Button>
          </>
        ) : (
          <>
            <div className={s.notice} role="status">
              There is no account link waiting in this browser, or it expired. Sign in with your identity
              provider again to start over.
            </div>
            <Button variant="primary" onClick={back}>
              Back to sign-in
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
