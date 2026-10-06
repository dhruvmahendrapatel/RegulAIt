/**
 * ADR-0182 (ADR-0175 batch D4) A13 — THE FEEDBACK FORM. OWNER: A13 (D4).
 *
 * One component, two routes (App.tsx, P0's):
 *   /feedback/:useCaseId  signed in, inside the app shell; may cite the trace
 *                         (and span) of the outcome being reported, which the
 *                         gateway checks belongs to the use case (422 if not);
 *   /f/:token             PUBLIC, no app chrome: a person outside the
 *                         organisation reports a problem or appeals a decision
 *                         through a signed link (shipped OFF; the gateway
 *                         answers 404 while the setting is off, 410 for an
 *                         expired, revoked or used-up link).
 *
 * What a person types is sent as JSON and never rendered back as HTML. The
 * body is at most 4000 characters on every channel.
 */
import { useId, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import { fmtAt } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Lockup } from "../../ui/Brand";
import { Button, Card, ErrorState, Field, Input, SkeletonBlock, Textarea } from "../../ui/kit";
import v from "../views.module.css";
import f from "./feedback.module.css";

const BODY_MAX = 4000;
type Kind = "problem" | "appeal";
const KINDS: Array<{ id: Kind; title: string; body: string }> = [
  { id: "problem", title: "Report a problem", body: "Something the system did was wrong, unsafe or unfair." },
  { id: "appeal", title: "Appeal a decision", body: "Ask for a decision the system made about you to be reviewed by a person." },
];

interface Receipt {
  reference: string;
  ackDueAt: string;
  resolveDueAt: string;
}

function refusalText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This link is not valid, or public feedback links are turned off.";
    if (typeof e.payload.detail === "string") return e.payload.detail;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function FeedbackForm(props: {
  subject: string;
  allowTrace: boolean;
  submit: (body: Record<string, unknown>) => Promise<Receipt>;
  afterSubmit?: React.ReactNode;
}) {
  const [kind, setKind] = useState<Kind>("problem");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [traceId, setTraceId] = useState("");
  const [spanId, setSpanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const groupId = useId();
  const counterId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await props.submit({
        kind,
        body: body.trim(),
        ...(contact.trim() ? { contact: contact.trim() } : {}),
        ...(props.allowTrace && traceId.trim() ? { traceId: traceId.trim() } : {}),
        ...(props.allowTrace && traceId.trim() && spanId.trim() ? { spanId: spanId.trim() } : {}),
      });
      setReceipt(r);
    } catch (err) {
      setError(refusalText(err));
    } finally {
      setBusy(false);
    }
  };

  if (receipt) {
    return (
      <Card title="Thank you, it was received">
        <div className={v.stack} role="status">
          <p>
            Reference <span className={v.mono}>{receipt.reference.slice(0, 8)}</span>. Someone accountable for {props.subject}{" "}
            will acknowledge it by {fmtAt(receipt.ackDueAt)} and answer it by {fmtAt(receipt.resolveDueAt)}.
          </p>
          {props.afterSubmit}
        </div>
      </Card>
    );
  }

  const len = body.trim().length;
  return (
    <Card>
      <form className={v.stack} onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className={v.stackTight} aria-labelledby={groupId} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend id={groupId} className={v.sectionTitle}>
            What would you like to do?
          </legend>
          <div className={f.kinds}>
            {KINDS.map((k) => (
              <label key={k.id} className={[f.kind, kind === k.id ? f.kindSelected : ""].join(" ")}>
                <input type="radio" name="kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
                <span>
                  <strong>{k.title}</strong>
                  <br />
                  <span className={v.faint}>{k.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={kind === "appeal" ? "What decision, and why should it be reviewed?" : "What happened?"} grow>
          <Textarea
            rows={8}
            maxLength={BODY_MAX}
            value={body}
            aria-describedby={counterId}
            onChange={(e) => setBody(e.target.value)}
            required
          />
        </Field>
        <span id={counterId} className={f.counter}>
          {len} of {BODY_MAX} characters
        </span>
        <Field label="How can we reach you? (optional)">
          <Input value={contact} maxLength={500} autoComplete="email" onChange={(e) => setContact(e.target.value)} />
        </Field>
        {props.allowTrace && (
          <div className={v.row}>
            <Field label="Trace ID (optional)">
              <Input value={traceId} onChange={(e) => setTraceId(e.target.value)} placeholder="the trace of the outcome" />
            </Field>
            <Field label="Span ID (optional)">
              <Input value={spanId} disabled={!traceId.trim()} onChange={(e) => setSpanId(e.target.value)} />
            </Field>
          </div>
        )}
        <p className={v.faint}>
          What you write is stored encrypted, read only by the person accountable for {props.subject} or an administrator
          (each reading is recorded), and deleted after the organisation&apos;s retention period.
        </p>
        {error && (
          <p role="alert" className={v.errLine}>
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={busy || len === 0 || len > BODY_MAX}>
            {kind === "appeal" ? "Send appeal" : "Send report"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SignedInForm(props: { useCaseId: string }) {
  // the name is shown when the reader may see the use case; anyone may report
  const uc = useQuery({
    queryKey: ["feedback", "use-case-name", props.useCaseId],
    queryFn: () => api.get<{ useCase?: { name?: string }; name?: string }>(`/v1/use-cases/${props.useCaseId}`),
    retry: false,
  });
  const name = uc.data?.useCase?.name ?? uc.data?.name ?? null;
  const subject = name ? `"${name}"` : "this use case";
  return (
    <>
      <PageHeader title="Report a problem or appeal a decision" sub={name ? `About ${name}` : "About an AI use case"} />
      <FeedbackForm
        subject={subject}
        allowTrace
        submit={async (body) => {
          const r = await api.post<{ id: string; ackDueAt: string; resolveDueAt: string }>(`/v1/use-cases/${props.useCaseId}/feedback`, body);
          return { reference: r.id, ackDueAt: r.ackDueAt, resolveDueAt: r.resolveDueAt };
        }}
        afterSubmit={
          <p>
            You can follow its status under <Link to="/feedback">Feedback and appeals → Sent by me</Link>.
          </p>
        }
      />
    </>
  );
}

function PublicForm(props: { token: string }) {
  const info = useQuery({
    queryKey: ["feedback", "public", props.token],
    queryFn: () => api.get<{ useCaseName: string; expiresAt: string }>(`/v1/feedback/l/${encodeURIComponent(props.token)}`),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <main className={f.public}>
      <div className={f.panel}>
        <div className={f.brand}>
          <Lockup markSize={26} />
        </div>
        <h1>Report a problem or appeal a decision</h1>
        {info.isLoading ? (
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
        ) : info.error ? (
          <ErrorState title="This link cannot be used" message={refusalText(info.error)} />
        ) : info.data ? (
          <>
            <p className={v.hint}>
              About <strong>{info.data.useCaseName}</strong>. You do not need an account.
            </p>
            <FeedbackForm
              subject={`"${info.data.useCaseName}"`}
              allowTrace={false}
              submit={(body) => api.post<Receipt>(`/v1/feedback/l/${encodeURIComponent(props.token)}`, body)}
            />
          </>
        ) : null}
      </div>
    </main>
  );
}

export default function FeedbackFormPage(props: { public?: boolean }) {
  const { useCaseId, token } = useParams();
  if (props.public) return <PublicForm token={token ?? ""} />;
  if (!useCaseId) return <ErrorState title="No use case" message="Open the form from a use case's feedback tab." />;
  return <SignedInForm useCaseId={useCaseId} />;
}
