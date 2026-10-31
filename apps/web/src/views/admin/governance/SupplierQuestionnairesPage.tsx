/**
 * ADR-0221 — Supplier questionnaires (/admin/vendors/questionnaires): the supplier portal's on/off switch, and the
 * custom questionnaires an admin can add to a supplier's access on top of the framework's controls.
 *
 * The portal ships OFF (the strict default). Turning it on is a relaxation: the gateway asks the admin to confirm it's
 * them (`withStepUp`) and records it as one. Turning it off withdraws every unused link and ends every supplier
 * session at once, so it asks first.
 *
 * A questionnaire is versioned: a row is one version, editing publishes the next one under the same name, and a
 * retired version cannot be added to new access (access that already uses it keeps it).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDay, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Fieldset, InfoButton, Input, RowActions, Table, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { QueryGate, useAction } from "../adminKit";
import {
  blankQuestion,
  draftsFrom,
  groupQuestionnaires,
  nextQuestionId,
  questionProblems,
  questionsBody,
  QUESTIONS_MAX,
  type QuestionDraft,
  type SupplierQuestionnaire,
} from "./supplierAccessModel";
import v from "../../views.module.css";
import sa from "./supplierAccess.module.css";

const PORTAL_COPY = {
  label: "Supplier portal",
  strict:
    "Off: no supplier can sign in, and no supplier access can be granted. Vendors' answers are typed in by your own team.",
  relaxed:
    "On: an admin can give one supplier contact a single-use link to answer one vendor's assessment. Links expire within " +
    "72 hours and access within 30 days; each answer waits for a reviewer. Turning it off again withdraws every unused " +
    "link and ends every supplier session.",
};

const UNSCANNED_COPY = {
  label: "Accept files that have not been scanned",
  strict: "Off: suppliers cannot attach files until a malware scanner is configured.",
  relaxed: "On: suppliers can attach files that nobody has scanned. Each download asks the reviewer to confirm.",
};

interface PortalSettings {
  enabled: boolean;
  acceptUnscannedFiles: boolean;
  scannerConfigured: boolean;
}

interface BuilderState {
  /** the version a new one is published from; null for a new questionnaire */
  from: SupplierQuestionnaire | null;
  name: string;
  description: string;
  questions: QuestionDraft[];
}
const newBuilder = (): BuilderState => ({ from: null, name: "", description: "", questions: [blankQuestion("q1")] });

export default function SupplierQuestionnairesPage() {
  const act = useAction();
  const settings = useQuery({
    queryKey: ["admin", "supplier-portal", "settings"],
    queryFn: () => api.get<PortalSettings>("/v1/supplier-portal/settings"),
  });
  const list = useQuery({
    queryKey: ["admin", "supplier-questionnaires"],
    queryFn: () => api.get<{ questionnaires: SupplierQuestionnaire[] }>("/v1/supplier-questionnaires"),
  });

  const [confirmOff, setConfirmOff] = useState(false);
  const [builder, setBuilder] = useState<BuilderState>(newBuilder);
  const [tried, setTried] = useState(false);
  const [retiring, setRetiring] = useState<SupplierQuestionnaire | null>(null);

  const enabled = settings.data?.enabled === true;
  // fail closed: only an explicit "yes" reads as relaxed
  const acceptUnscanned = settings.data?.acceptUnscannedFiles === true;
  const scannerConfigured = settings.data?.scannerConfigured === true;
  const groups = groupQuestionnaires(list.data?.questionnaires ?? []);
  const problems = questionProblems(builder.questions);
  const nameProblem = builder.from === null && !builder.name.trim() ? "Give the questionnaire a name." : builder.name.trim().length > 120 ? "The name can be at most 120 characters." : null;
  const descProblem = builder.description.trim().length > 2000 ? "The description can be at most 2,000 characters." : null;
  const nextVersion = builder.from
    ? Math.max(builder.from.version, ...(groups.find((g) => g.name === builder.from!.name)?.versions.map((x) => x.version) ?? [])) + 1
    : 1;
  const valid = !nameProblem && !descProblem && !problems.list && problems.byIndex.every((p) => p === null);

  const setPortal = (on: boolean) => {
    setConfirmOff(false);
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.put("/v1/supplier-portal/settings", { enabled: on }, h));
      await settings.refetch();
    }, on ? "Supplier portal turned on. This is recorded as a relaxation." : "Supplier portal turned off. Unused links and supplier sessions were withdrawn.");
  };

  const setUnscanned = (on: boolean) => {
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.put("/v1/supplier-portal/settings", { acceptUnscannedFiles: on }, h));
      await settings.refetch();
    }, on ? "Unscanned files are now accepted. This is recorded as a relaxation." : "Unscanned files are refused again.");
  };

  const setQuestion = (i: number, patch: Partial<QuestionDraft>) =>
    setBuilder((b) => ({ ...b, questions: b.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  const publish = () => {
    setTried(true);
    if (!valid || act.busy) return;
    const b = builder;
    void act.run(async () => {
      if (b.from) {
        await withStepUp((h) =>
          stepUpApi.post(`/v1/supplier-questionnaires/${b.from!.id}/versions`, { description: b.description.trim(), questions: questionsBody(b.questions) }, h),
        );
      } else {
        await withStepUp((h) =>
          stepUpApi.post("/v1/supplier-questionnaires", { name: b.name.trim(), description: b.description.trim(), questions: questionsBody(b.questions) }, h),
        );
      }
      setBuilder(newBuilder());
      setTried(false);
      await list.refetch();
    }, b.from ? `New version of ${b.from.name} published` : "Questionnaire published");
  };

  const retire = (q: SupplierQuestionnaire) => {
    setRetiring(null);
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`/v1/supplier-questionnaires/${q.id}/retire`, {}, h));
      await list.refetch();
    }, `${q.name}, version ${q.version} retired`);
  };

  return (
    <>
      <PageHeader
        title="Supplier questionnaires"
        crumbs={["AI Governance", "Vendors"]}
        sub="Turn the supplier portal on or off, and write the extra questions a supplier answers."
        actions={<Link to="/admin/vendors">Back to vendors</Link>}
        info={
          <p>
            With the supplier portal on, an admin can let one person at a supplier answer a vendor&apos;s assessment
            directly, from the vendor&apos;s page. They answer the controls of the framework you choose and, if you add one,
            a questionnaire from this page. Every answer waits for a reviewer before it is recorded.
          </p>
        }
      />
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert" data-testid="supplier-questionnaires-error">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />

        {/* ---- the portal switch ---- */}
        <Card title="Supplier portal">
          <QueryGate loading={settings.isPending} error={settings.error} onRetry={() => void settings.refetch()}>
            <div className={v.stack}>
              <div className={v.row}>
                <strong>{enabled ? "On" : "Off"}</strong>
                <InfoButton label={PORTAL_COPY.label}>{enabled ? PORTAL_COPY.relaxed : PORTAL_COPY.strict}</InfoButton>
                {enabled ? <Badge tone="warn">Relaxed</Badge> : <Badge tone="ok">Strict default</Badge>}
              </div>
              <p className={v.hint}>{enabled ? PORTAL_COPY.relaxed : PORTAL_COPY.strict}</p>
              <div className={v.row}>
                {enabled ? (
                  <Button aria-disabled={act.busy || undefined} onClick={() => !act.busy && setConfirmOff(true)}>
                    Turn the portal off
                  </Button>
                ) : (
                  <>
                    <Button variant="primary" aria-disabled={act.busy || undefined} onClick={() => !act.busy && setPortal(true)}>
                      Turn the portal on
                    </Button>
                    <span className={v.faint}>Turning it on is a relaxation: you will be asked to confirm it&apos;s you.</span>
                  </>
                )}
              </div>
              <section className={v.stackTight} aria-labelledby="supplier-unscanned-title" data-testid="supplier-unscanned-setting">
                <h3 id="supplier-unscanned-title" className={v.sectionTitle}>
                  Files from suppliers
                </h3>
                {scannerConfigured ? (
                  <p className={v.hint}>A scanner checks every file.</p>
                ) : (
                  <div className={v.stack}>
                    <div className={v.row}>
                      <span>{UNSCANNED_COPY.label}:</span>
                      <strong>{acceptUnscanned ? "On" : "Off"}</strong>
                      <InfoButton label={UNSCANNED_COPY.label}>{acceptUnscanned ? UNSCANNED_COPY.relaxed : UNSCANNED_COPY.strict}</InfoButton>
                      {acceptUnscanned ? <Badge tone="warn">Relaxed</Badge> : <Badge tone="ok">Strict default</Badge>}
                    </div>
                    <p className={v.hint}>{acceptUnscanned ? UNSCANNED_COPY.relaxed : UNSCANNED_COPY.strict}</p>
                    <div className={v.row}>
                      {acceptUnscanned ? (
                        <Button aria-disabled={act.busy || undefined} onClick={() => !act.busy && setUnscanned(false)}>
                          Stop accepting unscanned files
                        </Button>
                      ) : (
                        <>
                          <Button aria-disabled={act.busy || undefined} onClick={() => !act.busy && setUnscanned(true)}>
                            Accept unscanned files
                          </Button>
                          <span className={v.faint}>This is a relaxation: you will be asked to confirm it&apos;s you.</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section>
              <p className={v.hint}>
                Invite a supplier from the vendor&apos;s page in <Link className={sa.inlineLink} to="/admin/vendors">Vendors</Link>.
              </p>
            </div>
          </QueryGate>
        </Card>

        {/* ---- the questionnaires ---- */}
        <Card title="Questionnaires">
          <QueryGate loading={list.isPending} error={list.error} onRetry={() => void list.refetch()}>
            {groups.length === 0 ? (
              <EmptyState title="No questionnaires yet" body="Write one below. A supplier always answers the framework's controls; a questionnaire adds your own questions." />
            ) : (
              <div className={v.stack}>
                {groups.map((g) => (
                  <section key={g.name} className={v.stackTight} aria-label={g.name}>
                    <h3 className={v.sectionTitle}>{g.name}</h3>
                    <Table<SupplierQuestionnaire>
                      rows={g.versions}
                      rowKey={(q) => q.id}
                      columns={[
                        { key: "version", header: "Version", render: (q) => `Version ${q.version}` },
                        { key: "questions", header: "Questions", render: (q) => plural(q.questions.length, "question") },
                        { key: "created", header: "Published", render: (q) => fmtDay(q.createdAt) },
                        {
                          key: "state",
                          header: "State",
                          render: (q) =>
                            q.retiredAt ? <Badge tone="neutral">{`Retired ${fmtDay(q.retiredAt)}`}</Badge> : <Badge tone="ok">In use</Badge>,
                        },
                        {
                          key: "actions",
                          header: "",
                          srHeader: "Actions",
                          render: (q) => (
                            <RowActions
                              slot="7.5rem"
                              primary={
                                <Button
                                  size="sm"
                                  aria-label={`New version from ${q.name}, version ${q.version}`}
                                  aria-disabled={act.busy || undefined}
                                  onClick={() => {
                                    setTried(false);
                                    setBuilder({ from: q, name: q.name, description: q.description, questions: draftsFrom(q.questions) });
                                    document.getElementById("questionnaire-builder")?.scrollIntoView({ block: "start" });
                                  }}
                                >
                                  New version
                                </Button>
                              }
                              secondary={
                                q.retiredAt ? null : (
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    aria-label={`Retire ${q.name}, version ${q.version}`}
                                    aria-disabled={act.busy || undefined}
                                    onClick={() => !act.busy && setRetiring(q)}
                                  >
                                    Retire
                                  </Button>
                                )
                              }
                            />
                          ),
                        },
                      ]}
                    />
                  </section>
                ))}
              </div>
            )}
          </QueryGate>
        </Card>

        {/* ---- the builder ---- */}
        <Card title={builder.from ? `New version of ${builder.from.name}` : "New questionnaire"}>
          <form
            id="questionnaire-builder"
            className={v.stack}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              publish();
            }}
          >
            {builder.from ? (
              <p className={v.hint}>
                Publishing creates version {nextVersion}.
                Access that already uses an earlier version keeps it.
              </p>
            ) : (
              <Field label="Name" error={tried ? nameProblem : null}>
                <Input value={builder.name} maxLength={120} onChange={(e) => setBuilder({ ...builder, name: e.target.value })} />
              </Field>
            )}
            <Field label="Description (optional)" error={tried ? descProblem : null}>
              <Textarea rows={2} value={builder.description} onChange={(e) => setBuilder({ ...builder, description: e.target.value })} />
            </Field>

            {builder.questions.map((q, i) => (
              <Fieldset key={i} legend={`Question ${i + 1}`}>
                <div className={v.stackTight}>
                  <Field label="Question ID" help="A short ID that stays the same across versions, such as q1 or data-retention. Lower-case letters, digits, hyphens and underscores.">
                    <Input value={q.id} maxLength={64} onChange={(e) => setQuestion(i, { id: e.target.value })} />
                  </Field>
                  <Field label="Question">
                    <Textarea rows={2} value={q.prompt} maxLength={1000} onChange={(e) => setQuestion(i, { prompt: e.target.value })} />
                  </Field>
                  <Field label="Help for the supplier (optional)">
                    <Input value={q.help} maxLength={2000} onChange={(e) => setQuestion(i, { help: e.target.value })} />
                  </Field>
                  <Field
                    label="Control reference (optional)"
                    help="If you name a control of the framework, an accepted answer is recorded against that control. Without one, an accepted answer is kept with the supplier's answers only."
                  >
                    <Input value={q.controlRef} maxLength={200} onChange={(e) => setQuestion(i, { controlRef: e.target.value })} />
                  </Field>
                  <div className={v.row}>
                    <label className={v.row}>
                      <input type="checkbox" checked={q.required} onChange={(e) => setQuestion(i, { required: e.target.checked })} />
                      <span>Answer required</span>
                    </label>
                    <label className={v.row}>
                      <input type="checkbox" checked={q.allowFile} onChange={(e) => setQuestion(i, { allowFile: e.target.checked })} />
                      <span>Supplier may attach a file</span>
                    </label>
                    <span className={v.grow} />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove question ${i + 1}`}
                      disabled={builder.questions.length === 1}
                      onClick={() => setBuilder({ ...builder, questions: builder.questions.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </Button>
                  </div>
                  {tried && problems.byIndex[i] && (
                    <div className={v.errLine} role="alert">
                      {problems.byIndex[i]}
                    </div>
                  )}
                </div>
              </Fieldset>
            ))}
            {tried && problems.list && (
              <div className={v.errLine} role="alert">
                {problems.list}
              </div>
            )}
            <div className={v.row}>
              <Button
                disabled={builder.questions.length >= QUESTIONS_MAX}
                onClick={() => setBuilder({ ...builder, questions: [...builder.questions, blankQuestion(nextQuestionId(builder.questions))] })}
              >
                Add a question
              </Button>
              <span className={v.grow} />
              {builder.from && (
                <Button variant="ghost" onClick={() => { setTried(false); setBuilder(newBuilder()); }}>
                  Cancel
                </Button>
              )}
              <Button type="submit" variant="primary" aria-disabled={act.busy || undefined}>
                {builder.from ? "Publish new version" : "Publish questionnaire"}
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <ConfirmModal
        open={confirmOff}
        title="Turn the supplier portal off?"
        body={<p>Every unused sign-in link stops working and every supplier who is signed in is signed out now. Access you granted is kept, so you can issue new links after turning it on again.</p>}
        confirmLabel="Turn the portal off"
        danger
        onConfirm={() => setPortal(false)}
        onCancel={() => setConfirmOff(false)}
      />
      <ConfirmModal
        open={retiring !== null}
        title={retiring ? `Retire ${retiring.name}, version ${retiring.version}?` : "Retire this version?"}
        body={<p>No new supplier access can use this version. Access that already uses it keeps it. A retired version cannot be brought back; publish a new version instead.</p>}
        confirmLabel="Retire version"
        danger
        onConfirm={() => retiring && retire(retiring)}
        onCancel={() => setRetiring(null)}
      />
    </>
  );
}
