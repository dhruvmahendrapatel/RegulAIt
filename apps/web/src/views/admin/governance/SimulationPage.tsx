/**
 * Simulation / Access preview — the flagship precedence-chain visualizer.
 * "Would this call be allowed right now?" runs the live policy kernel via
 * POST /v1/evaluate without executing anything, then renders every rule
 * evaluated, in order, as a vertical chain: the terminal match highlighted,
 * each step badged with its outcome, grant/rule ids as copyable chips.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { EvaluateDecision, RuleTrace } from "../../../api/adminTypes";
import { UUID_RE } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, IdChip, Select, type Tone } from "../../../ui/kit";
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
        sub="Would this call be allowed right now? Evaluates live policy without executing anything — the same kernel, the same precedence, zero side effects."
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
      </div>
    </>
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
