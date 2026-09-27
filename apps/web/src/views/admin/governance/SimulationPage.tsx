/**
 * Simulation / Access preview, and the BLAST RADIUS beside it.
 *
 * Two questions, deliberately on one screen because they are the two halves of
 * "may I commit this change":
 *
 *  - **What would this decide, right now, for this one call?** (ADR-0040) The
 *    precedence-chain visualizer: `POST /v1/evaluate` runs the live kernel
 *    without executing anything, and every rule it walked renders in order.
 *  - **Who would a PROPOSED policy version newly block?** (ADR-0059) The
 *    single-tuple preview answers a question you thought to ask; the blast
 *    radius answers the one you did not, by replaying real recorded history
 *    against a candidate version that has never been activated. It NAMES the
 *    users, the projects and the specific calls — a percentage without a name
 *    is not something anyone can act on before committing.
 *
 * Two honesties rendered rather than documented: the dry-run/fidelity
 * disclosure comes back on every response and is shown next to the numbers, and
 * `newly allowed` is labelled as structurally zero (ABAC cannot grant) so the
 * zero reads as a property of the model rather than an absence of evidence.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { EvaluateDecision, RuleTrace } from "../../../api/adminTypes";
import { UUID_RE } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, IdChip, Input, Select, Table, type Tone } from "../../../ui/kit";
import {
  optionEls,
  serverOpts,
  useAction,
  useServerTools,
  useServers,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const OUTCOME_TONE: Record<RuleTrace["outcome"], Tone> = {
  allow: "ok",
  deny: "danger",
  revoked: "danger",
  "require-approval": "warn",
  "satisfied-by-approval": "ok",
  "no-match": "neutral",
};

/** plain-language gloss per rule name (the precedence ladder, top to bottom) */
const RULE_GLOSS: Record<string, string> = {
  "user-revocation": "A per-user revocation beats everything — it can only ever deny.",
  "tool-allow-list": "Direct per-user tool grant.",
  "role-tool-allow-list": "Tool grant bundled on a role this user holds.",
  "server-read-only-all": "Server-wide read-only grant (direct).",
  "role-server-read-only-all": "Server-wide read-only grant via a role.",
  "approval-rule": "A matching approval rule pauses the call for its named approver.",
  "data-scope-rule": "Argument values constrained to an allow-list.",
  "rate-limit": "Max calls per window.",
  "default-deny": "Nothing matched — the default is always deny.",
};

export default function SimulationPage() {
  const users = useUsers();
  const servers = useServers();
  const act = useAction();

  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const tools = useServerTools(serverId || null);
  const [result, setResult] = useState<EvaluateDecision | null>(null);
  const [evaluatedLabel, setEvaluatedLabel] = useState("");

  const userLabel =
    users.data?.users.find((u) => u.id === userId)?.displayName ??
    users.data?.users.find((u) => u.id === userId)?.email ??
    "";
  const serverLabel = servers.data?.servers.find((s) => s.id === serverId)?.name ?? "";

  return (
    <>
      <PageHeader
        title="Simulation / access preview"
        sub="Would this call be allowed right now? Evaluated live, executing nothing."
        info={<p>Would this call be allowed right now? Evaluates live policy without executing anything — the same kernel, the same precedence, zero side effects.</p>}
      />
      <div className={v.stack}>
        <Card>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                const d = await api.post<EvaluateDecision>("/v1/evaluate", {
                  userId,
                  serverId,
                  toolName,
                });
                setResult(d);
                setEvaluatedLabel(`${userLabel} → ${serverLabel} · ${toolName}`);
              }, null);
            }}
          >
            <Field label="User">
              <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— select a user —")}
              </Select>
            </Field>
            <Field label="Server">
              <Select
                required
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value);
                  setToolName("");
                }}
              >
                {optionEls(serverOpts(servers.data?.servers), "— select a server —")}
              </Select>
            </Field>
            <Field label="Tool">
              <Select required value={toolName} onChange={(e) => setToolName(e.target.value)}>
                {optionEls(
                  (tools.data?.tools ?? []).map((t) => ({ v: t.name, l: `${t.name} (${t.kind})` })),
                  "— select a tool —",
                )}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Evaluate
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
        </Card>

        {result === null ? (
          <Card>
            <EmptyState
              title="Run an evaluation to see the decision"
              body="Pick a user, a server and a tool — the full precedence chain renders here, every rule in the order the kernel walked it."
            />
          </Card>
        ) : (
          <DecisionView decision={result} label={evaluatedLabel} />
        )}

        <BlastRadiusPanel />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ADR-0059 — blast radius
// ---------------------------------------------------------------------------

interface SimulationRow {
  id: string;
  policyName: string;
  policyVersion: number;
  considered: number;
  newlyDenied: number;
  newlyApprovalRequired: number;
  newlyAllowed: number;
  unchanged: number;
  indeterminate: number;
  affectedUsers: number;
  affectedProjects: number;
  affectedTools: number;
  capped: boolean;
  fidelityExact: boolean;
  fidelityCaveats: Array<{ attribute: string; why: string }>;
  headline: string;
  windowDays: number;
  blastRadius: {
    users?: Array<{ userId: string; label: string | null; calls: number }>;
    projects?: Array<{ projectId: string | null; name: string | null; calls: number }>;
    tools?: Array<{ serverId: string; toolName: string; calls: number }>;
  };
  createdAt: string;
}
interface FlipRow {
  id: string;
  userLabel: string | null;
  projectName: string | null;
  toolName: string;
  recordedEffect: string;
  simulatedEffect: string;
  occurredAt: string;
}

function BlastRadiusPanel() {
  const act = useAction();
  const [versionId, setVersionId] = useState("");
  const [windowDays, setWindowDays] = useState("30");
  const [sim, setSim] = useState<{ simulation: SimulationRow; samples: FlipRow[]; fidelity: string; abacCannotGrant: string } | null>(
    null,
  );
  const history = useQuery({
    queryKey: ["admin", "policy-simulations"],
    queryFn: () => api.get<{ simulations: SimulationRow[]; fidelity: string }>("/v1/policy-simulations?limit=25"),
  });

  return (
    <Card title="Blast radius — what would a PROPOSED policy version have changed?">
      <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
        {history.data?.fidelity}
      </div>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.post<{
              simulation: SimulationRow;
              samples: FlipRow[];
              fidelity: string;
              abacCannotGrant: string;
            }>("/v1/policy-simulations", {
              policyVersionId: versionId,
              windowDays: Number(windowDays) || 30,
            });
            setSim(r);
            await history.refetch();
          }, "Dry run complete — nothing was executed and nothing was activated");
        }}
      >
        <Field label="Proposed policy version id" grow>
          <Input value={versionId} onChange={(e) => setVersionId(e.target.value)} required />
        </Field>
        <Field label="Window (days)">
          <Input value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Preview
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}

      {sim ? (
        <>
          <p style={{ margin: "var(--s2) 0 0", fontWeight: 650 }}>{sim.simulation.headline}</p>
          {sim.simulation.capped ? (
            <div className={v.faint}>
              The row cap was reached, so these counts are a LOWER BOUND, not a total.
            </div>
          ) : null}
          {sim.simulation.fidelityExact ? null : (
            <div className={v.faint}>
              Replay is not exact for this candidate:{" "}
              {sim.simulation.fidelityCaveats.map((c) => `${c.attribute} — ${c.why}`).join(" · ")}
            </div>
          )}
          <div className={v.row} style={{ marginTop: "var(--s2)", flexWrap: "wrap" }}>
            <Badge tone="danger">newly blocked: {sim.simulation.newlyDenied}</Badge>
            <Badge tone="warn">newly needs approval: {sim.simulation.newlyApprovalRequired}</Badge>
            <Badge tone="neutral" title={sim.abacCannotGrant}>
              newly allowed: {sim.simulation.newlyAllowed} (structurally always zero)
            </Badge>
            <Badge tone="ok">unchanged: {sim.simulation.unchanged}</Badge>
            <Badge tone="info">could not be replayed exactly: {sim.simulation.indeterminate}</Badge>
          </div>

          <div className={v.sectionTitle}>Who — named, not counted</div>
          <Table
            rows={sim.simulation.blastRadius.users ?? []}
            rowKey={(r) => r.userId}
            columns={[
              { key: "who", header: "User", render: (r) => r.label ?? r.userId },
              { key: "calls", header: "Calls that would flip", render: (r) => r.calls },
            ]}
          />
          <div className={v.sectionTitle}>Which projects</div>
          <Table
            rows={sim.simulation.blastRadius.projects ?? []}
            rowKey={(r) => r.projectId ?? "unattributed"}
            columns={[
              { key: "p", header: "Project", render: (r) => r.name ?? "(unattributed)" },
              { key: "calls", header: "Calls", render: (r) => r.calls },
            ]}
          />
          <div className={v.sectionTitle}>A sample of the specific calls</div>
          <Table
            rows={sim.samples}
            rowKey={(r) => r.id}
            columns={[
              { key: "who", header: "Who", render: (r) => r.userLabel ?? "—" },
              { key: "tool", header: "Tool", render: (r) => <code>{r.toolName}</code> },
              { key: "proj", header: "Project", render: (r) => r.projectName ?? "(unattributed)" },
              {
                key: "flip",
                header: "Would change",
                render: (r) => `${r.recordedEffect} → ${r.simulatedEffect}`,
              },
            ]}
          />
        </>
      ) : (
        <EmptyState
          title="No preview run yet"
          body="Paste a proposed policy version id. The dry run re-decides recorded history under that version — it dispatches nothing, queues nothing, and does not activate the policy."
        />
      )}

      <div className={v.sectionTitle}>Previous previews</div>
      <Table
        rows={history.data?.simulations ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: "p", header: "Policy", render: (r) => `${r.policyName} v${r.policyVersion}` },
          { key: "win", header: "Window", render: (r) => `${r.windowDays}d` },
          { key: "considered", header: "Calls examined", render: (r) => r.considered },
          { key: "blocked", header: "Newly blocked", render: (r) => r.newlyDenied },
          { key: "users", header: "Users", render: (r) => r.affectedUsers },
        ]}
      />
    </Card>
  );
}

function DecisionView(props: { decision: EvaluateDecision; label: string }) {
  const d = props.decision;
  const chain = d.ruleChain ?? [];
  // the step that decided: the last trace naming the matched rule, falling
  // back to the last non-"no-match" outcome (default-deny chains match none)
  let terminalIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (d.ruleId && chain[i]!.rule === d.ruleId) {
      terminalIdx = i;
      break;
    }
  }
  if (terminalIdx === -1) {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i]!.outcome !== "no-match") {
        terminalIdx = i;
        break;
      }
    }
  }
  const bannerClass =
    d.effect === "allow"
      ? a.effectBannerAllow
      : d.effect === "deny"
        ? a.effectBannerDeny
        : a.effectBannerApproval;
  return (
    <Card title={`Decision — ${props.label}`}>
      <div className={`${a.effectBanner} ${bannerClass}`} data-testid="decision-effect">
        <span className={a.effectWord}>{d.effect.replaceAll("_", " ")}</span>
        {d.ruleId && (
          <span className={v.rowTight}>
            <span className={v.dim}>matched</span>
            <span className={v.mono}>{d.ruleId}</span>
          </span>
        )}
      </div>
      {d.reason && <p style={{ margin: "var(--s2) 0 0" }}>{d.reason}</p>}
      {d.effect === "require_approval" && (d.approverName || d.approverUserId) && (
        <p className={v.dim} style={{ margin: "var(--s1) 0 0" }}>
          Requires sign-off from {d.approverName ?? d.approverUserId}
        </p>
      )}

      <div className={v.sectionTitle}>Precedence chain — every rule evaluated, in order</div>
      {chain.length === 0 ? (
        <EmptyState title="No rules recorded" />
      ) : (
        <div className={a.chain} data-testid="rule-chain">
          {chain.map((t, i) => {
            const tone = OUTCOME_TONE[t.outcome] ?? "neutral";
            const terminal = i === terminalIdx && t.outcome !== "no-match";
            const dotClass =
              tone === "ok"
                ? a.chainDotAllow
                : tone === "danger"
                  ? a.chainDotDeny
                  : tone === "warn"
                    ? a.chainDotWarn
                    : "";
            return (
              <div key={i} className={a.chainStep}>
                <div className={a.chainRail}>
                  <span className={`${a.chainDot} ${dotClass}`} aria-hidden>
                    {i + 1}
                  </span>
                  <span className={a.chainLine} />
                </div>
                <div className={`${a.chainBody} ${terminal ? a.chainMatched : ""}`}>
                  <div className={v.row}>
                    <span className={v.mono} style={{ fontWeight: 650 }}>
                      {t.rule}
                    </span>
                    <Badge tone={tone}>{t.outcome.replaceAll("-", " ")}</Badge>
                    {terminal && <Badge tone="primary">decides</Badge>}
                    {t.grantId &&
                      (UUID_RE.test(t.grantId) ? (
                        <IdChip id={t.grantId} />
                      ) : (
                        <span className={v.mono}>{t.grantId}</span>
                      ))}
                  </div>
                  {RULE_GLOSS[t.rule] && <div className={v.faint}>{RULE_GLOSS[t.rule]}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <details style={{ marginTop: "var(--s2)" }}>
        <summary className={v.dim} style={{ cursor: "pointer" }}>
          Raw decision JSON
        </summary>
        <div style={{ marginTop: "var(--s1)" }}>
          <CodeBlock maxHeight="320px">{JSON.stringify(d, null, 2)}</CodeBlock>
        </div>
      </details>
    </Card>
  );
}
