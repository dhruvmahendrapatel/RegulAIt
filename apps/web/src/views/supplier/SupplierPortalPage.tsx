/**
 * The supplier portal (ADR-0221): the page a supplier contact opens from the single-use link an admin sent them,
 * `<base>/ui/supplier#<token>`. It sits OUTSIDE the app shell and talks only to the supplier API (`/supplier/v1/…`)
 * with plain `fetch`: the platform client would treat a 401 as a lost platform session, and a supplier has none.
 *
 * On load, a token in the address fragment is taken out of the address at once (`history.replaceState`), so it is not
 * left in the address bar or the history, and then spent for a session cookie (HttpOnly, scoped to the supplier API;
 * this page never sees it). Without a token the page tries the cookie it may already hold. Every refusal is the
 * server's own sentence, shown inline.
 *
 * What a supplier types is sent as JSON and rendered back as text only.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { fmtAt, fmtBytes, frameworkLabel } from "../../api/format";
import { Lockup } from "../../ui/Brand";
import { Badge, Button, Card, EmptyState, ErrorState, Field, SkeletonBlock, Textarea, type Tone } from "../../ui/kit";
import v from "../views.module.css";
import s from "./supplier.module.css";
import {
  ACCEPT_ATTRIBUTE,
  fileLimitLabel,
  fileProblem,
  FILES_NOT_ACCEPTED_NOTE,
  LINK_REFUSAL_DETAIL,
  readFileAsBase64,
  SESSION_REFUSAL_DETAIL,
  statementProblem,
  SUPPLIER_STATUS_LABEL,
  tokenFromHash,
  withoutHash,
  type SubmissionStatus,
} from "./supplierPortal";

const NETWORK_FAILURE = "We could not reach the service. Check your connection and try again.";

interface Control {
  controlRef: string;
  title: string;
  description: string | null;
}
interface Question {
  id: string;
  prompt: string;
  help: string;
  required: boolean;
  allowFile: boolean;
  controlRef: string | null;
}
interface Submission {
  id: string;
  kind: "control" | "question";
  controlRef: string | null;
  questionId: string | null;
  statement: string;
  file: { name: string; contentType: string | null; size: number | null; scanStatus: string | null } | null;
  status: SubmissionStatus;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}
interface Assessment {
  vendorName: string;
  framework: string;
  open: boolean;
  accessExpiresAt: string;
  sessionExpiresAt: string;
  controls: Control[];
  questionnaire: { name: string; version: number; description: string; questions: Question[] } | null;
  submissions: Submission[];
  limits: Limits;
}
/** `filesAccepted` is false while no malware scanner is configured and an admin has not chosen to take unscanned files */
interface Limits {
  fileMaxBytes: number;
  statementMax: number;
  filesAccepted: boolean;
  fileBytesBudget: number;
}

type Target = { kind: "control"; controlRef: string } | { kind: "question"; questionId: string };

type Answer<T> = { status: number; body: (T & { detail?: string; error?: string }) | null };

/** the answer's JSON body, or null (a refusal page that is not JSON reads as no body) */
async function readAnswer<T>(res: Response): Promise<Answer<T>> {
  let body: Answer<T>["body"] = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = (await res.json()) as Answer<T>["body"];
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

/** a GET on the supplier API (the cookie rides along); throws only when the server cannot be reached */
async function getJson<T>(path: string): Promise<Answer<T>> {
  try {
    return await readAnswer<T>(await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } }));
  } catch (cause) {
    throw new Error(NETWORK_FAILURE, { cause });
  }
}

/** a POST on the supplier API with the CSRF header; throws only when the server cannot be reached */
async function postJson<T>(path: string, body: unknown): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "x-regulait-csrf": "1" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(NETWORK_FAILURE, { cause });
  }
  return readAnswer<T>(res);
}

/** the server's own sentence for a refusal, or a plain fallback */
function refusalText(status: number, body: { detail?: string } | null, fallback: string): string {
  if (body && typeof body.detail === "string" && body.detail.trim()) return body.detail;
  if (status === 404) return LINK_REFUSAL_DETAIL;
  if (status === 401) return SESSION_REFUSAL_DETAIL;
  return fallback;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; data: Assessment }
  | { kind: "refused"; title: string; message: string }
  | { kind: "failed"; message: string }
  | { kind: "signedOut" };

const statusTone = (st: SubmissionStatus): Tone =>
  st === "accepted" ? "ok" : st === "rejected" ? "danger" : st === "withdrawn" ? "neutral" : "info";

/** the counter speaks only once the answer is close to the limit, never on every keystroke */
const NEAR_LIMIT_SHARE = 0.9;

export default function SupplierPortalPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const started = useRef(false);

  /** read the assessment; `quiet` keeps the current page up while it refreshes (after an answer was sent) */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPhase({ kind: "loading" });
    try {
      const r = await getJson<Assessment>("/supplier/v1/assessment");
      if (r.status === 200 && r.body) return setPhase({ kind: "ready", data: r.body });
      if (r.status === 401 || r.status === 404) {
        return setPhase({ kind: "refused", title: "Open your link to continue", message: refusalText(r.status, r.body, SESSION_REFUSAL_DETAIL) });
      }
      if (quiet) return; // the answer was sent; the list catches up on the next refresh
      return setPhase({ kind: "failed", message: refusalText(r.status, r.body, "The assessment could not be loaded. Try again in a moment.") });
    } catch (e) {
      if (quiet) return;
      return setPhase({ kind: "failed", message: e instanceof Error ? e.message : NETWORK_FAILURE });
    }
  }, []);

  useEffect(() => {
    // once per page load, also under React's development double-run
    if (started.current) return;
    started.current = true;
    const found = tokenFromHash(window.location.hash);
    if (found.kind !== "none") {
      // the token leaves the address bar and the history entry before anything else happens
      window.history.replaceState(window.history.state, "", withoutHash(window.location.pathname, window.location.search));
    }
    if (found.kind === "invalid") {
      setPhase({ kind: "refused", title: "This link cannot be used", message: LINK_REFUSAL_DETAIL });
      return;
    }
    if (found.kind === "none") {
      void load();
      return;
    }
    void (async () => {
      try {
        const r = await postJson<{ vendorName: string }>("/supplier/v1/session", { token: found.token });
        if (r.status === 200) return void (await load());
        setPhase({ kind: "refused", title: "This link cannot be used", message: refusalText(r.status, r.body, LINK_REFUSAL_DETAIL) });
      } catch (e) {
        setPhase({ kind: "failed", message: e instanceof Error ? e.message : NETWORK_FAILURE });
      }
    })();
  }, [load]);

  const signOut = async () => {
    try {
      await postJson("/supplier/v1/session/end", {});
    } catch {
      // the session ends on its own; what matters is that this page stops showing it
    }
    setPhase({ kind: "signedOut" });
  };

  return (
    <main className={s.page} id="rgMain" tabIndex={-1}>
      <div className={s.panel}>
        <div className={s.top}>
          <Lockup markSize={26} />
          {phase.kind === "ready" && (
            <Button onClick={() => void signOut()}>Sign out</Button>
          )}
        </div>
        <h1 className={s.title}>Supplier assessment</h1>
        {phase.kind === "loading" && (
          <Card>
            <div role="status" aria-label="Loading your assessment">
              <SkeletonBlock lines={5} />
            </div>
          </Card>
        )}
        {phase.kind === "refused" && (
          <Card>
            <ErrorState title={phase.title} message={phase.message} />
          </Card>
        )}
        {phase.kind === "failed" && (
          <Card>
            <ErrorState title="Something went wrong" message={phase.message} onRetry={() => void load()} />
          </Card>
        )}
        {phase.kind === "signedOut" && (
          <Card>
            <div role="status">
              <EmptyState
                title="You have signed out"
                body="To come back, open the most recent link you were sent. Each link works once; ask your contact for a new one if you need it."
              />
            </div>
          </Card>
        )}
        {phase.kind === "ready" && (
          <AssessmentView
            data={phase.data}
            onSessionEnded={(message) => setPhase({ kind: "refused", title: "Your session has ended", message })}
            onSubmitted={() => void load(true)}
          />
        )}
      </div>
    </main>
  );
}

function AssessmentView(props: { data: Assessment; onSessionEnded: (message: string) => void; onSubmitted: () => void }) {
  const d = props.data;
  const forTarget = (t: Target) =>
    d.submissions.filter((x) => (t.kind === "control" ? x.kind === "control" && x.controlRef === t.controlRef : x.kind === "question" && x.questionId === t.questionId));
  const questions = d.questionnaire?.questions ?? [];
  // fail closed: only an explicit "yes" from the server shows a file input
  const filesAccepted = d.limits.filesAccepted === true;
  return (
    <>
      <Card>
        <div className={v.stack}>
          <p className={s.prose}>
            You have been asked to answer an assessment about <strong>{d.vendorName}</strong>. Your answers go to your contact,
            who reviews each one. You can only see and answer this assessment.
          </p>
          <dl className={s.facts}>
            <div>
              <dt>Organisation assessed</dt>
              <dd>{d.vendorName}</dd>
            </div>
            <div>
              <dt>Framework</dt>
              <dd>{frameworkLabel(d.framework)}</dd>
            </div>
            <div>
              <dt>Your access ends</dt>
              <dd>{fmtAt(d.accessExpiresAt)}</dd>
            </div>
            <div>
              <dt>This session ends</dt>
              <dd>{fmtAt(d.sessionExpiresAt)}</dd>
            </div>
          </dl>
          <p className={v.hint}>
            For your security, the session also ends after 30 minutes without activity.
            {filesAccepted && (
              <>
                {" "}Files can be PDF, PNG, JPEG, plain text or CSV, at most {fileLimitLabel(d.limits.fileMaxBytes)} each, and{" "}
                {fileLimitLabel(d.limits.fileBytesBudget)} in total.
              </>
            )}
          </p>
          {!filesAccepted && (
            <p className={s.prose} data-testid="supplier-files-not-accepted">
              <strong>{FILES_NOT_ACCEPTED_NOTE}</strong>
            </p>
          )}
          {!d.open && (
            <div role="alert" className={v.errLine}>
              This assessment has been decided and no longer takes answers. You can still read what you sent.
            </div>
          )}
        </div>
      </Card>

      <Card title={`Controls (${d.controls.length})`}>
        {d.controls.length === 0 ? (
          <EmptyState title="No controls to answer" body="There is nothing to answer for this framework at the moment. Ask your contact if you expected some." />
        ) : (
          <div>
            {d.controls.map((c) => (
              <section key={c.controlRef} className={s.item} aria-labelledby={`c-${c.controlRef}`}>
                <h2 className={s.itemHead} id={`c-${c.controlRef}`}>
                  <span className={s.ref}>{c.controlRef}</span> <span>{c.title}</span>
                </h2>
                {c.description && <p className={`${s.prose} ${v.faint}`}>{c.description}</p>}
                <History items={forTarget({ kind: "control", controlRef: c.controlRef })} />
                <AnswerForm
                  target={{ kind: "control", controlRef: c.controlRef }}
                  label={`Your answer for ${c.controlRef}`}
                  allowFile={filesAccepted}
                  disabled={!d.open}
                  limits={d.limits}
                  onSessionEnded={props.onSessionEnded}
                  onSubmitted={props.onSubmitted}
                />
              </section>
            ))}
          </div>
        )}
      </Card>

      {d.questionnaire && (
        <Card title={`${d.questionnaire.name} (${questions.length})`}>
          <div>
            {d.questionnaire.description && <p className={`${s.prose} ${v.faint}`}>{d.questionnaire.description}</p>}
            {questions.map((q, i) => (
              <section key={q.id} className={s.item} aria-labelledby={`q-${q.id}`}>
                <h2 className={s.itemHead} id={`q-${q.id}`}>
                  <span className={s.ref}>Question {i + 1}</span> <span>{q.prompt}</span>
                  {q.required ? <Badge tone="neutral">Required</Badge> : <Badge tone="neutral">Optional</Badge>}
                </h2>
                {q.help && <p className={`${s.prose} ${v.faint}`}>{q.help}</p>}
                <History items={forTarget({ kind: "question", questionId: q.id })} />
                <AnswerForm
                  target={{ kind: "question", questionId: q.id }}
                  label={`Your answer to question ${i + 1}`}
                  allowFile={q.allowFile && filesAccepted}
                  disabled={!d.open}
                  limits={d.limits}
                  onSessionEnded={props.onSessionEnded}
                  onSubmitted={props.onSubmitted}
                />
              </section>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/** what the supplier already sent for one control or question, newest first */
function History(props: { items: Submission[] }) {
  if (props.items.length === 0) return null;
  return (
    <ul className={s.history} aria-label="What you sent">
      {props.items.map((x) => (
        <li key={x.id} className={s.historyItem}>
          <div className={v.row}>
            <Badge tone={statusTone(x.status)}>{SUPPLIER_STATUS_LABEL[x.status] ?? x.status}</Badge>
            <span className={v.faint}>Sent {fmtAt(x.createdAt)}</span>
          </div>
          <p className={s.prose}>{x.statement}</p>
          {x.file && (
            <span className={v.faint}>
              File: {x.file.name}
              {x.file.size != null ? ` (${fmtBytes(x.file.size)})` : ""}
            </span>
          )}
          {x.status === "rejected" && x.decisionReason && (
            <p className={s.prose}>
              <strong>Reason given: </strong>
              {x.decisionReason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function AnswerForm(props: {
  target: Target;
  label: string;
  allowFile: boolean;
  disabled: boolean;
  limits: Limits;
  onSessionEnded: (message: string) => void;
  onSubmitted: () => void;
}) {
  const [statement, setStatement] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const fileHintId = useId();
  const counterId = useId();
  const nearLimit = statement.length >= Math.floor(props.limits.statementMax * NEAR_LIMIT_SHARE);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || props.disabled) return;
    setSent(false);
    const sp = statementProblem(statement, props.limits.statementMax);
    if (sp) return setProblem(sp);
    const fp = file ? fileProblem(file, props.limits.fileMaxBytes) : null;
    if (fp) return setProblem(fp);
    setProblem(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { target: props.target, statement: statement.trim() };
      if (file) body.file = { name: file.name, base64: await readFileAsBase64(file) };
      const r = await postJson("/supplier/v1/submissions", body);
      if (r.status === 201) {
        setStatement("");
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        setSent(true);
        props.onSubmitted();
        return;
      }
      if (r.status === 401) return props.onSessionEnded(refusalText(401, r.body, SESSION_REFUSAL_DETAIL));
      // the server stopped taking files since the page loaded: refresh, so the file input goes away
      if (r.body?.error === "files_not_accepted") props.onSubmitted();
      setProblem(refusalText(r.status, r.body, "Your answer could not be sent. Try again in a moment."));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : NETWORK_FAILURE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={v.stackTight} onSubmit={(e) => void submit(e)} noValidate>
      <Field label={props.label}>
        <Textarea
          rows={4}
          value={statement}
          maxLength={props.limits.statementMax}
          disabled={props.disabled}
          aria-describedby={counterId}
          onChange={(e) => setStatement(e.target.value)}
        />
      </Field>
      <span id={counterId} className={s.counter}>
        {statement.length.toLocaleString("en-GB")} of {props.limits.statementMax.toLocaleString("en-GB")} characters
      </span>
      {/* one fixed sentence once the answer nears the limit: read out once, not on every keystroke */}
      <span role="status" className={v.faint}>
        {nearLimit ? `Your answer is close to the limit of ${props.limits.statementMax.toLocaleString("en-GB")} characters.` : ""}
      </span>
      {props.allowFile && (
        <div className={v.stackTight}>
          <label htmlFor={fileId}>Supporting file (optional)</label>
          <input
            id={fileId}
            ref={fileRef}
            className={s.fileInput}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={props.disabled}
            aria-describedby={fileHintId}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setProblem(f ? fileProblem(f, props.limits.fileMaxBytes) : null);
            }}
          />
          <span id={fileHintId} className={v.faint}>
            PDF, PNG, JPEG, plain text or CSV, at most {fileLimitLabel(props.limits.fileMaxBytes)}.
          </span>
        </div>
      )}
      {problem && (
        <div role="alert" className={v.errLine}>
          {problem}
        </div>
      )}
      {sent && (
        <div role="status" className={v.faint}>
          Answer sent. Your contact will review it.
        </div>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={props.disabled} aria-disabled={busy || undefined}>
          {busy ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </form>
  );
}
