/**
 * ADR-0187 "Engines page" (X26, batch 5) — `/admin/engines`, Integrations group.
 *
 * Every sidecar engine (promptfoo and garak for red-teaming, modelscan for
 * model artifacts) with what an admin needs to decide whether it may run:
 * version, image digest, signature status, licence, maintainer count,
 * usage-data posture (its switches and the last egress probe), health (each
 * runner's last report and the engine's self-test), last run, timeout and
 * budget, the pages that use it, its re-check-by date, the air-gapped reduced
 * set and what is still unverified. Actions: enable or disable, change the
 * limits, run the self-test, mint an enrolment token (shown once), revoke a
 * runner.
 *
 * The rules this page keeps (ADR-0180, ADR-0187):
 *  - Secure by default: every engine is OFF until an admin enables it; enabling
 *    and every relaxation (a longer timeout, a higher budget ceiling, more
 *    concurrency) go through `withStepUp`, so the gateway's `settings_relax`
 *    step-up is asked for, never skipped.
 *  - Decision 79: a build that does not isolate the runner credential is
 *    refused (409 `engine_credential_isolation_missing`). This page never sends
 *    `acceptCredentialIsolationRisk` on its own: only after that refusal, with
 *    the gateway's reason shown and an explicit acknowledgement ticked, and
 *    then still through the step-up.
 *  - Nothing unmeasured reads as healthy (engineModel.ts). A run status is
 *    never shown as a verdict; results live on the run surfaces. Health is
 *    re-judged at the earliest self-test expiry, so an open page never keeps
 *    a stale green.
 *  - Destructive actions (switching off, revoking a runner, a self-test that
 *    may switch the engine off) are confirmed with their consequences and the
 *    audit record they write.
 *  - An enrolment token is shown once, in the dialog that minted it (focused,
 *    open until dismissed), kept only in this component's state, and gone when
 *    the dialog closes.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { ago, fmtAt, fmtUsd, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, Input, Modal, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { KV, QueryGate } from "../adminKit";
import { IsolationPanel } from './isolation/IsolationPanel';
import { IsolationSettingsCard } from './isolation/IsolationSettings';
import { EngineStatusBadge } from "./EngineStatusBadge";
import {
  ENGINE_DIAL_LIMITS,
  ENROLLMENT_TTL_MINUTES,
  dialPatch,
  dialProblem,
  egressReadings,
  engineHealth,
  failureText,
  buildOfRefusal,
  isBuildChangedRefusal,
  isCredentialIsolationRefusal,
  lastRunText,
  pagesUsing,
  RUNNER_REVOKE_REASON_MAX,
  raisedDials,
  revokeReasonProblem,
  runnerOnCurrentBuild,
  runnerSelfTestReading,
  shortDigest,
  startFreshnessClock,
  type EngineBuild,
  type EngineDial,
} from "./engineModel";
import type {
  DetectionContentPack,
  Engine,
  EnginePatch,
  EngineRunner,
  EngineSelfTest,
  EnginesResponse,
  EnrollmentTokenMinted,
  RunnerRevoked,
} from "./engineTypes";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const ENGINES_KEY = ["admin", "engines"] as const;

const useEngines = () =>
  useQuery({ queryKey: ENGINES_KEY, queryFn: () => api.get<EnginesResponse>("/v1/engines") });

/** ADR-0186 V's vendored detection content; a 501 `not_built` until that slice lands */
const useDetectionContent = () =>
  useQuery({
    queryKey: ["admin", "detection-content"],
    queryFn: () => api.get<{ packs: DetectionContentPack[] }>("/v1/detection-content"),
    retry: false,
  });

type ModalState =
  | { kind: "enable"; engine: Engine }
  | { kind: "accept-risk"; engine: Engine; detail: string; build: EngineBuild | null; notice: string | null }
  | { kind: "disable"; engine: Engine }
  | { kind: "self-test"; engine: Engine }
  | { kind: "enrol"; engine: Engine; minted?: EnrollmentTokenMinted }
  | { kind: "limits"; engine: Engine }
  | { kind: "revoke"; engine: Engine; runner: EngineRunner }
  | null;

/**
 * One write at a time, its refusal kept against the engine it was about (so it
 * renders in that engine's card, not somewhere else on a long page).
 */
function useEngineAction() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ engineId: string; message: string } | null>(null);
  const run = async <T,>(engineId: string, fn: () => Promise<T>, okMsg: (out: T) => string): Promise<{ ok: true; out: T } | { ok: false; err: unknown }> => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      toast(okMsg(out), "success");
      return { ok: true, out };
    } catch (err) {
      return { ok: false, err };
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ENGINES_KEY });
    }
  };
  const fail = (engineId: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setError({ engineId, message });
    toast(message, "error");
  };
  return { busy, error, run, fail };
}

const patchEngine = (id: string, body: EnginePatch) =>
  withStepUp((h) => stepUpApi.patch<Engine>(`/v1/engines/${id}`, body, h));

export default function EnginesPage() {
  const engines = useEngines();
  const content = useDetectionContent();
  const act = useEngineAction();
  const [modal, setModal] = useState<ModalState>(null);
  const [selfTestRan, setSelfTestRan] = useState<Record<string, EngineSelfTest>>({});
  const close = () => setModal(null);
  const list = engines.data?.engines ?? [];
  // PR #230 review: health is judged against the clock at every render, and a
  // render is forced just after the earliest self-test expiry (at least every
  // FRESHNESS_RECHECK_CAP_MS), so a page left open never keeps a stale green.
  // Re-armed whenever the engine list changes.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const engineList = engines.data?.engines ?? [];
    return startFreshnessClock(
      () => engineList,
      () => setClockTick((t) => t + 1),
    );
  }, [engines.data]);
  const now = Date.now();

  /**
   * `accepted` is the build the person ticked the acknowledgement for — always the
   * one a gateway refusal named, never the one this page loaded (B5W-07).
   */
  const enable = async (engine: Engine, accepted: EngineBuild | null, isolationDetail?: string) => {
    close();
    const res = await act.run(
      engine.id,
      () =>
        patchEngine(
          engine.id,
          accepted
            ? { enabled: true, acceptCredentialIsolationRisk: true, expectedVersion: accepted.version, expectedDigest: accepted.imageDigest }
            : { enabled: true },
        ),
      () => `${engine.displayName} enabled`,
    );
    if (res.ok) return;
    // decision 79: the gateway's refusal opens the explicit acceptance, never a silent resend
    if (!accepted && isCredentialIsolationRefusal(res.err)) {
      const detail = typeof res.err.payload.detail === "string" ? res.err.payload.detail : res.err.message;
      setModal({ kind: "accept-risk", engine, detail, build: buildOfRefusal(res.err), notice: null });
      return;
    }
    // B5W-07: the build rolled over (before the step-up or during it): nothing was enabled;
    // the acceptance comes back, unticked, for the build that is current now
    if (accepted && isBuildChangedRefusal(res.err)) {
      const build = buildOfRefusal(res.err);
      setModal({
        kind: "accept-risk",
        engine,
        detail: isolationDetail ?? "",
        build,
        notice:
          `The build changed since you reviewed it: it is now ${build ? `${build.version} (${shortDigest(build.imageDigest)})` : "a build the gateway did not name"}. ` +
          "Nothing was enabled. Review the current build and accept again only if you still want it.",
      });
      return;
    }
    act.fail(engine.id, res.err);
  };

  return (
    <>
      <PageHeader
        title="Engines"
        sub="Sidecar engines for red-teaming and model scanning: what each one is, whether it may run, and the runners that serve it."
        info={
          <p>
            Every engine is off until an administrator enables it. Enabling needs a passing self-test from the last 24 hours
            (the runner&apos;s own report from inside its container: image digest, version, each usage-data switch, and an
            egress probe that must fail) and your confirmation that it&apos;s you. Runs are started on the Red-teaming,
            Evaluations and Admission review pages; this page decides whether they may run at all.
          </p>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={engines.isLoading} error={engines.error} onRetry={() => void engines.refetch()}>
          {list.length === 0 ? (
            <Card>
              <EmptyState title="No engines are registered" body="The gateway reported no engine rows. Engines arrive with the gateway's migrations; nothing can run until they exist." />
            </Card>
          ) : (
            list.map((engine) => (
              <EngineCard
                key={engine.id}
                engine={engine}
                now={now}
                busy={act.busy}
                error={act.error?.engineId === engine.id ? act.error.message : null}
                selfTestRan={selfTestRan[engine.id] ?? null}
                onModal={setModal}
              />
            ))
          )}
          <ContentSetsCard query={content} taxonomyVersion={engines.data?.taxonomyVersion ?? null} />
        </QueryGate>
        <IsolationPanel />
        <IsolationSettingsCard />
      </div>

      <ConfirmModal
        open={modal?.kind === "enable"}
        title={modal?.kind === "enable" ? `Enable ${modal.engine.displayName}?` : ""}
        confirmLabel="Enable"
        body={modal?.kind === "enable" ? <EnableBody engine={modal.engine} /> : null}
        onCancel={close}
        onConfirm={() => modal?.kind === "enable" && void enable(modal.engine, null)}
      />
      {modal?.kind === "accept-risk" && (
        <AcceptRiskModal
          // a new build is a new acknowledgement: remount, so the tick never carries over
          key={modal.build ? `${modal.build.version}@${modal.build.imageDigest}` : "unnamed"}
          engine={modal.engine}
          detail={modal.detail}
          build={modal.build}
          notice={modal.notice}
          onCancel={close}
          onAccept={(build) => void enable(modal.engine, build, modal.detail)}
        />
      )}
      <ConfirmModal
        open={modal?.kind === "disable"}
        danger
        title={modal?.kind === "disable" ? `Switch ${modal.engine.displayName} off?` : ""}
        confirmLabel="Switch off"
        body={
          <div className={v.stack}>
            <p>
              Its active runs (leased, queued and awaiting approval) end now, and their run-scoped keys are revoked at once.
              Runners are refused new leases.
            </p>
            <p className={v.faint}>
              Turning it back on needs a fresh passing self-test and your step-up confirmation. Recorded in the audit log as{" "}
              <code>engine-updated</code>.
            </p>
          </div>
        }
        onCancel={close}
        onConfirm={() => {
          if (modal?.kind !== "disable") return;
          const engine = modal.engine;
          close();
          void act
            .run(engine.id, () => patchEngine(engine.id, { enabled: false }), () => `${engine.displayName} switched off`)
            .then((res) => !res.ok && act.fail(engine.id, res.err));
        }}
      />
      <ConfirmModal
        open={modal?.kind === "self-test"}
        title={modal?.kind === "self-test" ? `Run ${modal.engine.displayName}'s self-test?` : ""}
        confirmLabel="Run self-test"
        body={
          <div className={v.stack}>
            <p>
              The gateway judges the newest live runner of the current build against the build as shipped now. Nothing
              starts a container; the runner&apos;s own report is what is judged.
            </p>
            <p>
              <strong>If it fails, the engine is switched off</strong> and its active runs end, with their keys revoked.
            </p>
            <p className={v.faint}>
              Recorded in the audit log as <code>engine-self-test-passed</code> or <code>engine-self-test-failed</code>.
            </p>
          </div>
        }
        onCancel={close}
        onConfirm={() => {
          if (modal?.kind !== "self-test") return;
          const engine = modal.engine;
          close();
          void act
            .run(
              engine.id,
              () => stepUpApi.post<EngineSelfTest>(`/v1/engines/${engine.id}/self-test`, {}),
              (out) => (out.passed ? `${engine.displayName} self-test passed` : `${engine.displayName} self-test failed`),
            )
            .then((res) => {
              if (res.ok) setSelfTestRan((m) => ({ ...m, [engine.id]: res.out }));
              else act.fail(engine.id, res.err);
            });
        }}
      />
      {modal?.kind === "enrol" && (
        <EnrolModal
          engine={modal.engine}
          minted={modal.minted ?? null}
          busy={act.busy}
          // closing (the button, Escape or the backdrop) drops the token: it lives only in this dialog's state
          onCancel={close}
          onMint={(body) => {
            const engine = modal.engine;
            void act
              .run(
                engine.id,
                () => stepUpApi.post<EnrollmentTokenMinted>(`/v1/engines/${engine.id}/enrollment-tokens`, body),
                () => `Enrolment token minted for ${engine.displayName}`,
              )
              .then((res) => {
                if (!res.ok) {
                  close();
                  return act.fail(engine.id, res.err);
                }
                // PR #230 review: the token is shown in the dialog that minted it, which stays open until dismissed
                setModal({ kind: "enrol", engine, minted: res.out });
              });
          }}
        />
      )}
      {modal?.kind === "limits" && (
        <LimitsModal
          engine={modal.engine}
          onCancel={close}
          onSave={(body) => {
            const engine = modal.engine;
            close();
            void act
              .run(engine.id, () => patchEngine(engine.id, body), () => `${engine.displayName} limits saved`)
              .then((res) => !res.ok && act.fail(engine.id, res.err));
          }}
        />
      )}
      {modal?.kind === "revoke" && (
        <RevokeRunnerModal
          runner={modal.runner}
          busy={act.busy}
          onCancel={close}
          // PR #230 review: a refusal keeps the dialog open with the typed reason, and is shown in it
          onRevoke={async (reason) => {
            const { engine, runner } = modal;
            const res = await act.run(
              engine.id,
              () => api.del<RunnerRevoked>(`/v1/engine-runners/${runner.id}`, { reason }),
              (out) => `Runner ${runner.name} revoked; ${plural(out.endedRuns, "run")} ended`,
            );
            if (res.ok) {
              close();
              return null;
            }
            return res.err instanceof Error ? res.err.message : String(res.err);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// one engine
// ---------------------------------------------------------------------------

function EngineCard(props: {
  engine: Engine;
  now: number;
  busy: boolean;
  error: string | null;
  selfTestRan: EngineSelfTest | null;
  onModal: (m: ModalState) => void;
}) {
  const e = props.engine;
  const health = engineHealth(e, props.now);
  const posture = e.usageDataPosture;
  const reduced = e.airGappedReducedSet.length > 0 ? e.airGappedReducedSet : (posture?.airGappedReducedSet ?? []);
  const unverified = e.unverified.length > 0 ? e.unverified : (posture?.unverified ?? []);
  const overdue = e.reCheckBy !== null && e.reCheckBy < new Date(props.now).toISOString().slice(0, 10);
  const titleId = `engine-${e.id}-title`;
  return (
    <section aria-labelledby={titleId} data-testid={`engine-${e.id}`}>
      <Card
        title={
          <span id={titleId} style={{ display: "inline-flex", gap: "var(--s2)", alignItems: "center", flexWrap: "wrap" }}>
            {e.displayName} <span className={v.faint}>{e.version}</span> <EngineStatusBadge engine={e} now={props.now} />
          </span>
        }
      >
        <div className={v.stack}>
          <p className={v.dim}>{health.detail}</p>
          <div className={v.row} role="group" aria-label={`${e.displayName} actions`}>
            {e.enabled ? (
              <Button size="sm" variant="danger" disabled={props.busy} onClick={() => props.onModal({ kind: "disable", engine: e })}>
                Switch off
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={props.busy} onClick={() => props.onModal({ kind: "enable", engine: e })}>
                Enable…
              </Button>
            )}
            <Button size="sm" disabled={props.busy} onClick={() => props.onModal({ kind: "self-test", engine: e })}>
              Run self-test…
            </Button>
            <Button size="sm" disabled={props.busy} onClick={() => props.onModal({ kind: "enrol", engine: e })}>
              Mint enrolment token…
            </Button>
            <Button size="sm" disabled={props.busy} onClick={() => props.onModal({ kind: "limits", engine: e })}>
              Change limits…
            </Button>
          </div>
          {props.error && (
            <div className={v.errLine} role="alert">
              {props.error}
            </div>
          )}
          {props.selfTestRan && (
            <p role="status">
              Self-test just run:{" "}
              {props.selfTestRan.passed ? (
                <Badge tone="ok">passed</Badge>
              ) : (
                <Badge tone="danger">failed</Badge>
              )}{" "}
              {!props.selfTestRan.passed && <span className={v.dim}>{props.selfTestRan.failures.map(failureText).join("; ")}</span>}
            </p>
          )}

          <KV
            rows={[
              ["Kind", e.kind === "redteam" ? "Red-teaming" : e.kind === "model_scan" ? "Model artifact scanning" : e.kind],
              ["Image digest", e.imageDigest ? <code title={e.imageDigest}>{shortDigest(e.imageDigest)}</code> : <span>none (not built)</span>],
              ["Signature", e.signature === "not_built" ? <Badge>not built</Badge> : e.signature === "unverified" ? <Badge tone="warn">unverified</Badge> : <Badge>{e.signature}</Badge>],
              ["Licence", e.licence],
              ["Maintainers", e.maintainerCount === null ? <Badge tone="warn">not counted (unverified)</Badge> : String(e.maintainerCount)],
              ["Owner and ownership changes", <span className={v.faint}>not reported by the gateway yet</span>],
              ["Model access", e.needsModelAccess ? "Calls models through the gateway with a run-scoped key, pinned to the run's project" : "None (it reads uploaded artifacts only)"],
              ["Timeout", `${e.timeoutSeconds} s per run`],
              ["Budget ceiling", `${fmtUsd(e.maxBudgetUsd)} per run`],
              ["Concurrent runs", String(e.maxConcurrent)],
              ["Last run", e.lastRun ? <span>{lastRunText(e.lastRun.status)}, {ago(e.lastRun.createdAt)} <span className={v.faint}>(results are on the pages below)</span></span> : "none yet"],
              [
                "Used on",
                <span>
                  {pagesUsing(e.kind).map((p, i) => (
                    <span key={p.to}>
                      {i > 0 && ", "}
                      <Link to={p.to}>{p.label}</Link>
                    </span>
                  ))}
                </span>,
              ],
              ["Last verified", e.lastVerified ?? "never"],
              ["Re-check by", <span>{e.reCheckBy ?? "not set"} {overdue && <Badge tone="warn">overdue</Badge>}</span>],
            ]}
          />

          <Section title="Health">
            <SelfTestBlock engine={e} />
          </Section>

          <Section title="Usage-data posture">
            {posture && Object.keys(posture.switches).length > 0 ? (
              <ul aria-label={`${e.displayName} usage-data switches`}>
                {Object.entries(posture.switches).map(([name, value]) => (
                  <li key={name}>
                    <code>
                      {name}={value}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={v.faint}>No usage-data switch is declared for this build.</p>
            )}
            <EgressBlock egress={e.selfTest?.egress ?? null} at={e.selfTest?.at ?? null} />
          </Section>

          <Section title={`Runners (${e.runners.length})`}>
            <RunnersTable engine={e} now={props.now} busy={props.busy} onRevoke={(runner) => props.onModal({ kind: "revoke", engine: e, runner })} />
          </Section>

          {unverified.length > 0 && (
            <Section title="Not yet verified">
              <ul>
                {unverified.map((u) => (
                  <li key={u} className={v.dim}>
                    {u}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <details>
            <summary>
              Air-gapped reduced set: {reduced.length === 0 ? "nothing excluded" : `${plural(reduced.length, "item")} an air-gapped install cannot run`}
            </summary>
            {reduced.length > 0 && (
              <ul>
                {reduced.map((r) => (
                  <li key={`${r.key}:${r.reason}`}>
                    <code>{r.key}</code> <span className={v.faint}>not run: {r.reason.replaceAll("_", " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </Card>
    </section>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className={v.stackTight}>
      <h2 className={v.sectionTitle} style={{ margin: 0 }}>
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}

function SelfTestBlock(props: { engine: Engine }) {
  const t = props.engine.selfTest;
  if (!t) return <p className={v.faint}>No self-test is recorded. Nothing about this engine&apos;s runtime has been measured yet.</p>;
  return (
    <div className={v.stackTight}>
      <p>
        Engine self-test: {t.passed ? <Badge tone="ok">passed</Badge> : <Badge tone="danger">failed</Badge>}{" "}
        <span className={v.faint}>
          {ago(t.at)} ({fmtAt(t.at)}), build {t.version ?? "unknown"} {t.imageDigest ? shortDigest(t.imageDigest) : ""}
        </span>
      </p>
      {t.failures.length > 0 && (
        <ul aria-label="Self-test failures">
          {t.failures.map((f) => (
            <li key={f}>
              <code>{f}</code> <span className={v.dim}>{failureText(f)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EgressBlock(props: { egress: EngineSelfTest["egress"]; at: string | null }) {
  const readings = egressReadings(props.egress);
  if (!readings) return <p className={v.faint}>No egress probe is recorded, so egress has not been shown to be blocked.</p>;
  return (
    <div className={v.stackTight}>
      <p className={v.faint}>Last egress probe{props.at ? `, ${ago(props.at)}` : ""}: every reading must say blocked.</p>
      <ul aria-label="Last egress probe">
        {readings.map((r) => (
          <li key={r.label}>
            {r.label}: {r.blocked ? <Badge tone="ok">{r.value}</Badge> : <Badge tone={r.value === "not probed" ? "warn" : "danger"}>{r.value}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunnersTable(props: { engine: Engine; now: number; busy: boolean; onRevoke: (r: EngineRunner) => void }) {
  const e = props.engine;
  if (e.runners.length === 0) {
    return (
      <EmptyState
        title="No live runner"
        body="Nothing can lease this engine's runs. Mint an enrolment token and start a runner from the signed image with it."
      />
    );
  }
  return (
    <Table<EngineRunner>
      rows={e.runners}
      rowKey={(r) => r.id}
      columns={[
        { key: "name", header: "Runner", render: (r) => <code>{r.name}</code> },
        {
          key: "build",
          header: "Build",
          render: (r) => (
            <span>
              {r.reportedVersion} <code title={r.reportedDigest}>{shortDigest(r.reportedDigest)}</code>{" "}
              {!runnerOnCurrentBuild(e, r) && <Badge tone="warn">not the current build; its reports do not count</Badge>}
            </span>
          ),
        },
        {
          key: "selftest",
          header: "Its self-test",
          // PR #230 review: the recorded verdict counts only while the report is fresh (the lease's own rule)
          render: (r) => {
            const reading = runnerSelfTestReading(r, props.now);
            return (
              <span>
                <Badge tone={reading.tone}>{reading.label}</Badge>
                {r.selfTestReportedAt && <span className={v.faint}> reported {ago(r.selfTestReportedAt)}</span>}
                {r.selfTestPassed === false && <span className={v.dim}> {(r.selfTestFailures ?? []).map(failureText).join("; ")}</span>}
              </span>
            );
          },
        },
        { key: "seen", header: "Last seen", render: (r) => (r.lastSeenAt ? <span title={fmtAt(r.lastSeenAt)}>{ago(r.lastSeenAt)}</span> : "never") },
        { key: "registered", header: "Registered", render: (r) => <span title={fmtAt(r.registeredAt)}>{ago(r.registeredAt)}</span> },
        {
          key: "actions",
          header: "Actions",
          render: (r) => (
            <Button size="sm" variant="ghost" disabled={props.busy} aria-label={`Revoke runner ${r.name}`} onClick={() => props.onRevoke(r)}>
              Revoke
            </Button>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

/**
 * PR #230 review: the revocation reason is bounded as the gateway bounds it
 * (revokeRunnerSchema: trimmed, 1–RUNNER_REVOKE_REASON_MAX characters), with a
 * counter; a refusal keeps this dialog open with the typed reason and shows why.
 */
function RevokeRunnerModal(props: { runner: EngineRunner; busy: boolean; onCancel: () => void; onRevoke: (reason: string) => Promise<string | null> }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const length = reason.trim().length;
  const tooLong = length > RUNNER_REVOKE_REASON_MAX;
  const counterId = `revoke-reason-count-${props.runner.id}`;
  const go = async () => {
    const problem = revokeReasonProblem(reason);
    if (problem) {
      setErr(problem);
      return;
    }
    setErr(null);
    setErr(await props.onRevoke(reason.trim()));
  };
  return (
    <Modal
      open
      title={`Revoke runner ${props.runner.name}?`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="danger" disabled={tooLong || props.busy} onClick={() => void go()}>
            Revoke runner
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p>
          Its runner token authenticates nothing from now on. Runs it holds end as cancelled and their run-scoped keys are
          revoked at once. To serve this engine again, enrol a runner with a new enrolment token.
        </p>
        <p className={v.faint}>
          Recorded in the audit log as <code>engine-runner-revoked</code>, with your reason.
        </p>
        <Input
          placeholder="reason (required, audited)"
          aria-label="Reason"
          aria-describedby={counterId}
          aria-invalid={tooLong}
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !tooLong && !props.busy) void go();
          }}
        />
        <span id={counterId} className={tooLong ? v.errLine : v.faint}>
          {length} / {RUNNER_REVOKE_REASON_MAX} characters{tooLong ? " — too long; the gateway refuses more" : ""}
        </span>
        {err && (
          <div className={v.errLine} role="alert">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}

function EnableBody(props: { engine: Engine }) {
  const e = props.engine;
  return (
    <div className={v.stack}>
      {/* PR #230 review: only an engine whose manifest needs model access gets a run-scoped key */}
      {e.needsModelAccess ? (
        <p>
          Runners of {e.displayName} {e.version} may then lease its queued runs. Each run gets a run-scoped key, pinned to its
          project, that stops at the run&apos;s budget (ceiling {fmtUsd(e.maxBudgetUsd)}) and its timeout ({e.timeoutSeconds}{" "}
          s).
        </p>
      ) : (
        <p>
          Runners of {e.displayName} {e.version} may then lease its queued runs. Each run scans an uploaded model artifact,
          streamed to the runner through the gateway; it gets no model credentials and calls no model. A run stops at its
          timeout ({e.timeoutSeconds} s).
        </p>
      )}
      <p>
        The gateway refuses unless a self-test of this build passed in the last 24 hours. You will be asked to confirm
        it&apos;s you. If this build cannot keep the runner token away from the engine process, the gateway says so and you
        decide separately whether to accept that risk.
      </p>
      <p className={v.faint}>
        Recorded in the audit log as <code>engine-updated</code>.
      </p>
    </div>
  );
}

function AcceptRiskModal(props: {
  engine: Engine;
  detail: string;
  /** B5W-07: the build the gateway's refusal named; the acknowledgement and the request name exactly this one */
  build: EngineBuild | null;
  notice: string | null;
  onCancel: () => void;
  onAccept: (build: EngineBuild) => void;
}) {
  const e = props.engine;
  const build = props.build;
  const [ack, setAck] = useState(false);
  const id = `accept-risk-${e.id}`;
  return (
    <Modal
      open
      title={`Accept the credential-isolation risk for ${e.displayName}?`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Keep it off</Button>
          <Button variant="danger" disabled={!ack || build === null} onClick={() => build && props.onAccept(build)}>
            Accept risk and enable
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {props.notice && (
          <div className={v.errLine} role="alert" data-testid="build-changed-notice">
            {props.notice}
          </div>
        )}
        <p>The gateway refused to enable this engine:</p>
        <blockquote className={v.dim} data-testid="credential-isolation-reason" style={{ margin: 0, paddingLeft: "var(--s2)", borderLeft: "3px solid var(--border)" }}>
          {props.detail}
        </blockquote>
        <p>
          Accepting is recorded in the audit log on its own (<code>engine-credential-isolation-risk-accepted</code>), naming you
          and this build, and you will be asked to confirm it&apos;s you. A build that keeps the token out of the engine
          process removes the need for this acceptance.
        </p>
        {build ? (
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "flex-start" }}>
            <input id={id} type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} />
            <label htmlFor={id}>
              I accept that a compromised {e.displayName} engine could read its runner token for build {build.version} (
              {shortDigest(build.imageDigest)}), lease this engine&apos;s runs and post their results.
            </label>
          </div>
        ) : (
          <p className={v.errLine}>
            The gateway did not name the build this refusal is about, so its risk cannot be accepted here. Reload the page and
            try again.
          </p>
        )}
      </div>
    </Modal>
  );
}

function EnrolModal(props: {
  engine: Engine;
  minted: EnrollmentTokenMinted | null;
  busy: boolean;
  onCancel: () => void;
  onMint: (body: { label?: string; ttlMinutes: number }) => void;
}) {
  if (props.minted) return <EnrolTokenReveal engine={props.engine} minted={props.minted} onClose={props.onCancel} />;
  return <EnrolForm engine={props.engine} busy={props.busy} onCancel={props.onCancel} onMint={props.onMint} />;
}

/**
 * PR #230 review: the one-time token, in the dialog that minted it — never at
 * the top of a long page, screens away from the card that asked for it. Focus
 * moves to it so a screen reader announces it, and it stays until the admin
 * closes the dialog; closing discards it (it never leaves component state).
 */
function EnrolTokenReveal(props: { engine: Engine; minted: EnrollmentTokenMinted; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, []);
  return (
    <Modal
      open
      title={`Mint an enrolment token for ${props.engine.displayName}`}
      onClose={props.onClose}
      actions={
        <Button variant="primary" onClick={props.onClose}>
          I&apos;ve copied it — close
        </Button>
      }
    >
      <div ref={region} tabIndex={-1} role="region" aria-label="Enrolment token, shown once" className={v.stack}>
        <p>
          <Badge tone="warn">shown once</Badge> Copy it now: this is the only time it is shown, and the gateway keeps only its
          hash. Closing this dialog discards it.
        </p>
        <div className={a.secretRow}>
          <code className={a.secretCode} data-testid="revealed-secret">
            {props.minted.token}
          </code>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(props.minted.token);
                setCopied(true);
              } catch {
                toast("Clipboard unavailable — select the text manually", "error");
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className={v.faint}>
          It expires {fmtAt(props.minted.expiresAt)} and registers one runner, once. Give it to the runner as its enrolment
          token.
        </p>
      </div>
    </Modal>
  );
}

function EnrolForm(props: { engine: Engine; busy: boolean; onCancel: () => void; onMint: (body: { label?: string; ttlMinutes: number }) => void }) {
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(String(ENROLLMENT_TTL_MINUTES.default));
  const n = Number(ttl);
  const problem =
    !Number.isInteger(n) || n < ENROLLMENT_TTL_MINUTES.min || n > ENROLLMENT_TTL_MINUTES.max
      ? `Valid for must be a whole number of minutes from ${ENROLLMENT_TTL_MINUTES.min} to ${ENROLLMENT_TTL_MINUTES.max}`
      : label.trim().length > 100
        ? "Label must be at most 100 characters"
        : null;
  return (
    <Modal
      open
      title={`Mint an enrolment token for ${props.engine.displayName}`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={problem !== null || props.busy}
            onClick={() => props.onMint({ ...(label.trim() ? { label: label.trim() } : {}), ttlMinutes: n })}
          >
            Mint token
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p>
          A one-time token a runner exchanges for its own credential when it registers. It is shown once, here, and the
          gateway keeps only its hash. It cannot reach any other route.
        </p>
        <Field label="Label (optional)">
          <Input value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="e.g. rack-2 runner" maxLength={100} />
        </Field>
        <Field label="Valid for (minutes)">
          <Input type="number" min={ENROLLMENT_TTL_MINUTES.min} max={ENROLLMENT_TTL_MINUTES.max} step={1} value={ttl} onChange={(ev) => setTtl(ev.target.value)} />
        </Field>
        {problem && (
          <div className={v.errLine} role="alert">
            {problem}
          </div>
        )}
        <p className={v.faint}>
          Recorded in the audit log as <code>engine-enrollment-token-minted</code>.
        </p>
      </div>
    </Modal>
  );
}

const DIAL_LABEL: Record<EngineDial, string> = {
  timeoutSeconds: "Timeout (seconds)",
  maxBudgetUsd: "Budget ceiling (USD)",
  maxConcurrent: "Concurrent runs",
};

function LimitsModal(props: { engine: Engine; onCancel: () => void; onSave: (body: EnginePatch) => void }) {
  const e = props.engine;
  const [vals, setVals] = useState<Record<EngineDial, string>>({
    timeoutSeconds: String(e.timeoutSeconds),
    maxBudgetUsd: String(e.maxBudgetUsd),
    maxConcurrent: String(e.maxConcurrent),
  });
  const nums = { timeoutSeconds: Number(vals.timeoutSeconds), maxBudgetUsd: Number(vals.maxBudgetUsd), maxConcurrent: Number(vals.maxConcurrent) };
  const problems = (Object.keys(ENGINE_DIAL_LIMITS) as EngineDial[]).map((k) => dialProblem(k, nums[k])).filter((p): p is string => p !== null);
  const body = problems.length === 0 ? dialPatch(e, nums) : {};
  const raised = problems.length === 0 ? raisedDials(e, nums) : [];
  const changed = Object.keys(body).length > 0;
  return (
    <Modal
      open
      title={`Change ${e.displayName}'s limits`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!changed || problems.length > 0} onClick={() => props.onSave(body)}>
            Save limits
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {(Object.keys(ENGINE_DIAL_LIMITS) as EngineDial[]).map((k) => (
          <Field key={k} label={DIAL_LABEL[k]}>
            <Input
              type="number"
              min={ENGINE_DIAL_LIMITS[k].min}
              max={ENGINE_DIAL_LIMITS[k].max}
              step={k === "maxBudgetUsd" ? 0.01 : 1}
              value={vals[k]}
              onChange={(ev) => setVals((s) => ({ ...s, [k]: ev.target.value }))}
            />
          </Field>
        ))}
        {problems.length > 0 && (
          <div className={v.errLine} role="alert">
            {problems.join(". ")}
          </div>
        )}
        <p className={v.faint} aria-live="polite">
          {raised.length > 0
            ? `Raising ${raised.map((k) => DIAL_LABEL[k].toLowerCase()).join(", ")} loosens a limit, so you will be asked to confirm it's you.`
            : "Lowering a limit asks nothing more; raising one asks you to confirm it's you."}{" "}
          Recorded in the audit log as <code>engine-updated</code>.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// vendored content sets
// ---------------------------------------------------------------------------

function ContentSetsCard(props: { query: ReturnType<typeof useDetectionContent>; taxonomyVersion: number | null }) {
  const q = props.query;
  const notBuilt = q.error instanceof ApiError && q.error.status === 501;
  return (
    <Card title="Vendored content sets">
      <div className={v.stack}>
        <p className={v.faint}>
          Engine findings map onto red-team taxonomy version {props.taxonomyVersion ?? "unknown"}.
        </p>
        {q.isLoading ? (
          <p className={v.faint}>Loading content sets…</p>
        ) : notBuilt ? (
          <EmptyState
            title="Not available on this gateway yet"
            body="The vendored detection content's admin view is not built on this gateway, so no content set can be listed here. Nothing is implied about any set's version or licence."
          />
        ) : q.error ? (
          <ErrorState title="Couldn't load the content sets" message={q.error instanceof Error ? q.error.message : String(q.error)} onRetry={() => void q.refetch()} />
        ) : (
          <Table<DetectionContentPack>
            rows={q.data?.packs ?? []}
            rowKey={(p) => p.id}
            empty={<EmptyState title="No content set is vendored" />}
            columns={[
              { key: "id", header: "Set", render: (p) => <code>{p.id}</code> },
              { key: "source", header: "Source", render: (p) => p.source },
              { key: "commit", header: "Commit", render: (p) => <code title={p.sha256}>{p.commit.slice(0, 12)}</code> },
              { key: "licence", header: "Licence", render: (p) => p.licence },
              { key: "rules", header: "Rules", render: (p) => `${p.rules} imported, ${p.notImported} not imported` },
              { key: "enabled", header: "State", render: (p) => (p.enabled ? <Badge tone="info">in use</Badge> : <Badge>off</Badge>) },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
