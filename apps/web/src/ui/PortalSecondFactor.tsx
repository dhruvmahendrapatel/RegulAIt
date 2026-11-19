/**
 * ADR-0240 — the second-factor step both external portals show after a spent sign-in link (the supplier portal and
 * the auditor portal; each page supplies how a code is sent). The logic is in `portalSecondFactor.ts`.
 *
 * States, one at a time: `entering` (a code can be typed and sent; a refused code shows its reason here),
 * `checking` (a code is on its way, the button is off and says so), `ended` (the step is over: only a new link helps,
 * so no input is shown). A signed-in answer hands back to the page, which leaves this step.
 *
 * On enrolment the secret is shown once, from the answer that carried it; it is never stored.
 */
import { useId, useState, type FormEvent } from "react";
import { fmtAt } from "../api/format";
import { Button, Card, ErrorState, Field, Input } from "./kit";
import { TotpQrCode } from "./TotpQrCode";
import { cleanCode, type ExternalMfaStart, type MfaOutcome } from "./portalSecondFactor";

type Step = { kind: "entering"; refused: string | null } | { kind: "checking" } | { kind: "ended"; message: string };

export function PortalSecondFactor(props: {
  start: ExternalMfaStart;
  /** sends the code; resolves to what the page does next, and throws only when the server cannot be reached */
  submit: (code: string) => Promise<MfaOutcome>;
}) {
  const [step, setStep] = useState<Step>({ kind: "entering", refused: null });
  const [code, setCode] = useState("");
  const hintId = useId();
  const enrol = props.start.mfa === "enrol";

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "entering" || code.length !== 6) return;
    setStep({ kind: "checking" });
    try {
      const out = await props.submit(code);
      if (out.kind === "signedIn") return; // the page moves on
      setCode("");
      setStep(out.kind === "retry" ? { kind: "entering", refused: out.message } : { kind: "ended", message: out.message });
    } catch (err) {
      setStep({ kind: "entering", refused: err instanceof Error ? err.message : "The server could not be reached. Try again." });
    }
  };

  if (step.kind === "ended") {
    return (
      <Card>
        <ErrorState title="Sign-in could not be completed" message={step.message} />
      </Card>
    );
  }

  const checking = step.kind === "checking";
  const why = checking ? "Checking the code…" : code.length !== 6 ? "Enter all six digits to continue." : null;
  return (
    <Card title={enrol ? "Set up your second factor" : "Enter your code"}>
      <form onSubmit={(e) => void send(e)} noValidate>
        {enrol && props.start.mfa === "enrol" ? (
          <>
            <p>
              Scan this with an authenticator app, then enter the six-digit code it shows. This is shown once: if you close the
              page before confirming a code, the next link sets it up again with a new secret.
            </p>
            <TotpQrCode secret={props.start.secret} otpauthUri={props.start.otpauthUri} uriMaxHeight="90px" />
          </>
        ) : (
          <p>Enter the six-digit code from your authenticator app.</p>
        )}
        <Field label="Code from your authenticator">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            // no maxLength: a pasted "123 456" must keep all six digits; cleanCode keeps digits only, at most six
            value={code}
            disabled={checking}
            aria-describedby={hintId}
            aria-invalid={step.kind === "entering" && step.refused !== null ? true : undefined}
            onChange={(e) => setCode(cleanCode(e.target.value))}
            placeholder="123456"
          />
        </Field>
        <p id={hintId}>This step ends {fmtAt(props.start.challengeExpiresAt)}. After that, open a new link.</p>
        {step.kind === "entering" && step.refused && <p role="alert">{step.refused}</p>}
        <Button type="submit" variant="primary" disabled={why !== null} title={why ?? undefined}>
          {checking ? "Checking…" : enrol ? "Confirm and continue" : "Continue"}
        </Button>
        {why && !checking && <p>{why}</p>}
      </form>
    </Card>
  );
}
