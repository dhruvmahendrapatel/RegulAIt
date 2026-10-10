/**
 * ADR-0186 A — the ONE "confirm it's you" dialog, mounted in the shell.
 *
 * It answers a step-up prompt (`stepUp.ts`): asks the gateway which proofs it
 * accepts for this exact action (`POST /v1/auth/step-up/options`), then offers
 * them — a passkey (`@simplewebauthn/browser`), an authenticator code, or a
 * fresh sign-in at the identity provider (opened in a new tab; this dialog
 * polls `GET /v1/auth/step-up/:id` until the provider has confirmed it). The
 * grant goes back to whoever asked, which resends the original request with
 * it. Every failed attempt starts a new ceremony (each one is single use).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ApiError, codeSentence } from "../api/client";
import { Button, Field, Input, Modal } from "../ui/kit";
import v from "../views/views.module.css";
import {
  api,
  installGlobalStepUp,
  STEP_UP_ACTION_COPY,
  subscribeStepUpPrompt,
  type StepUpPrompt,
} from "./stepUp";

interface OptionsResponse {
  stepUpId: string;
  actionKind: string;
  methods: string[];
  expiresAt: string;
  passkey?: { options: PublicKeyCredentialRequestOptionsJSON };
  sso?: { redirectUrl: string; provider: string };
}
interface GrantResponse {
  stepUpToken: string;
  expiresAt: string;
}

const SSO_POLL_MS = 2000;

function reasonOf(err: unknown): string {
  if (err instanceof ApiError) {
    const code = typeof err.payload.error === "string" ? err.payload.error : "";
    if (code === "invalid_code") return "That code wasn't accepted. Wait for the next code from your app and try again.";
    if (code === "passkey_signature_invalid") return "Your passkey couldn't be verified. Try again with a passkey registered to your account.";
    return code ? codeSentence(code) : err.message;
  }
  if (err instanceof Error && err.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you're ready.";
  return err instanceof Error ? err.message : String(err);
}

export default function StepUpDialog() {
  const [prompt, setPrompt] = useState<StepUpPrompt | null>(null);
  const [opts, setOpts] = useState<OptionsResponse | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [waitingSso, setWaitingSso] = useState(false);
  const promptRef = useRef<StepUpPrompt | null>(null);

  useEffect(() => installGlobalStepUp(), []);
  useEffect(
    () =>
      subscribeStepUpPrompt((p) => {
        promptRef.current = p;
        setPrompt(p);
      }),
    [],
  );

  // a new ceremony for the open prompt
  const begin = async (p: StepUpPrompt) => {
    setOpts(null);
    setUnavailable(null);
    setWaitingSso(false);
    setCode("");
    try {
      const o = await api.post<OptionsResponse>("/v1/auth/step-up/options", { action: p.action });
      if (promptRef.current?.id === p.id) setOpts(o);
    } catch (err) {
      if (promptRef.current?.id !== p.id) return;
      if (err instanceof ApiError && err.status === 422) setUnavailable(reasonOf(err));
      else setError(reasonOf(err));
    }
  };

  useEffect(() => {
    setError(null);
    if (prompt) void begin(prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id]);

  // the fresh sign-in completes in another tab: poll until the provider confirmed it
  useEffect(() => {
    if (!waitingSso || !opts || !prompt) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void api
        .get<{ status: string } & Partial<GrantResponse>>(`/v1/auth/step-up/${opts.stepUpId}`)
        .then((r) => {
          if (stopped) return;
          if (r.status === "granted" && r.stepUpToken) prompt.finish(r.stepUpToken);
        })
        .catch((err: unknown) => {
          if (stopped) return;
          setWaitingSso(false);
          setError(reasonOf(err));
          void begin(prompt);
        });
    }, SSO_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSso, opts?.stepUpId, prompt?.id]);

  if (!prompt) return null;
  const what = STEP_UP_ACTION_COPY[prompt.actionKind] ?? "this action";

  const verify = async (body: Record<string, unknown>) => {
    if (!opts) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.post<GrantResponse>("/v1/auth/step-up/verify", { stepUpId: opts.stepUpId, ...body });
      prompt.finish(g.stepUpToken);
    } catch (err) {
      setError(reasonOf(err));
      void begin(prompt); // that ceremony is spent: start a new one
    } finally {
      setBusy(false);
    }
  };

  const confirmWithPasskey = async () => {
    if (!opts?.passkey) return;
    setBusy(true);
    setError(null);
    let response: unknown;
    try {
      response = await startAuthentication({ optionsJSON: opts.passkey.options });
    } catch (err) {
      setBusy(false);
      setError(reasonOf(err));
      void begin(prompt);
      return;
    }
    setBusy(false);
    await verify({ method: "passkey", response });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 6) void verify({ method: "totp", code });
  };

  const offers = (m: string) => Boolean(opts?.methods.includes(m));

  return (
    <Modal
      open
      title="Confirm it's you"
      onClose={() => prompt.finish(null)}
      actions={
        <Button onClick={() => prompt.finish(null)} disabled={busy}>
          Cancel
        </Button>
      }
    >
      <div className={v.stack} data-testid="step-up-dialog">
        <p style={{ margin: 0 }}>
          You're {what}. RegulAIt asks you to prove it's you right now, for this one action. The confirmation can't be
          reused for anything else.
        </p>
        {error && (
          <div className={v.errLine} role="alert">
            {error}
          </div>
        )}
        {unavailable ? (
          <div className={v.stack}>
            <div className={v.errLine} role="alert">
              {unavailable}
            </div>
            <Link to="/account?section=passkeys" onClick={() => prompt.finish(null)}>
              Set up a passkey or an authenticator app on your Account page
            </Link>
          </div>
        ) : !opts ? (
          <div className={v.faint} role="status">
            Getting ready…
          </div>
        ) : (
          <div className={v.stack}>
            {offers("passkey") && opts.passkey && (
              <Button variant="primary" disabled={busy} onClick={() => void confirmWithPasskey()}>
                Use a passkey
              </Button>
            )}
            {offers("totp") && (
              <form onSubmit={submitCode} className={v.row} style={{ alignItems: "flex-end" }}>
                <Field label="Authenticator code">
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                </Field>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  Confirm with code
                </Button>
              </form>
            )}
            {offers("sso") && opts.sso && (
              <div className={v.stack}>
                <a
                  href={opts.sso.redirectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setError(null);
                    setWaitingSso(true);
                  }}
                >
                  Sign in again with {opts.sso.provider || "your identity provider"} (opens a new tab)
                </a>
                {waitingSso && (
                  <div className={v.faint} role="status">
                    Waiting for you to finish signing in. Come back to this tab when you're done.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
