/**
 * PROTOTYPE (#453 G7) — Edit profile: a wide dialog prefilled with every field a
 * compliance profile carries, then a review step that shows what changes, which
 * of the changes loosen a floor, what the change reaches, and who reviews it.
 * Nothing applies on submit: it creates the next version, pending a reviewer.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { ComplianceProfile, WorkflowTemplate } from "../../../api/adminTypes";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Field, Input, Modal, Select, Table, Textarea } from "../../../ui/kit";
import { optionEls, useAction, useUsers } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const DETECTORS = ["pii", "prompt_injection", "jailbreak", "toxicity", "semantic_dlp"] as const;
export const ATTACK_CLASSES = ["prompt_injection", "jailbreak", "data_exfiltration", "pii_leak", "tool_abuse", "excessive_agency"] as const;
type Detector = (typeof DETECTORS)[number];

export interface ProfileRecord extends ComplianceProfile {
  version?: number;
  status?: "active" | "retired";
  retiredAt?: string | null;
  maxProjectBudgetUsd?: number | null;
  budgetEnforcement?: "block" | "warn_only" | null;
  guardrailModes?: Partial<Record<Detector, "off" | "log" | "warn" | "block">> | null;
  redteamGatingClasses?: string[] | null;
  redteamMinTrials?: number | null;
  redteamFailOnSeverity?: "low" | "medium" | "high" | "critical" | null;
  minIsolationClass?: "hardened_container" | "user_space_kernel" | "microvm" | null;
  usage?: { projects: string[]; teams: string[]; resources: string[] };
}

type Form = {
  requiredTemplateIds: string[];
  mcpDefaultMode: string;
  piiMode: string;
  auditRetentionDays: string;
  backupRetentionDays: string;
  patchCadenceDays: string;
  maxProjectBudgetUsd: string;
  budgetEnforcement: string;
  guardrailModes: Record<Detector, string>;
  redteamGatingClasses: string[];
  redteamMinTrials: string;
  redteamFailOnSeverity: string;
  minIsolationClass: string;
};

const s = (n: number | null | undefined) => (n == null ? "" : String(n));
const toForm = (p: ProfileRecord): Form => ({
  requiredTemplateIds: p.requiredTemplateIds ?? [],
  mcpDefaultMode: p.mcpDefaultMode,
  piiMode: p.piiMode,
  auditRetentionDays: s(p.auditRetentionDays),
  backupRetentionDays: s(p.backupRetentionDays),
  patchCadenceDays: s(p.patchCadenceDays),
  maxProjectBudgetUsd: s(p.maxProjectBudgetUsd),
  budgetEnforcement: p.budgetEnforcement ?? "",
  guardrailModes: Object.fromEntries(DETECTORS.map((d) => [d, p.guardrailModes?.[d] ?? ""])) as Record<Detector, string>,
  redteamGatingClasses: p.redteamGatingClasses ?? [],
  redteamMinTrials: s(p.redteamMinTrials),
  redteamFailOnSeverity: p.redteamFailOnSeverity ?? "",
  minIsolationClass: p.minIsolationClass ?? "",
});

type Effect = "loosens" | "tightens";
interface DiffRow {
  field: string;
  now: string;
  proposed: string;
  effect: Effect;
}

const num = (x: string) => (x === "" ? null : Number(x));
const RANK = {
  mcp: { read_write: 0, read_only: 1 } as Record<string, number>,
  pii: { log: 1, warn: 2, block: 3 } as Record<string, number>,
  enforcement: { "": 0, warn_only: 1, block: 2 } as Record<string, number>,
  guard: { "": 0, off: 0, log: 1, warn: 2, block: 3 } as Record<string, number>,
  // a lower fail-on severity fails more runs: stricter
  severity: { "": 0, critical: 1, high: 2, medium: 3, low: 4 } as Record<string, number>,
  isolation: { "": 0, hardened_container: 1, user_space_kernel: 2, microvm: 3 } as Record<string, number>,
};
const shown = (x: string, unit = "") => (x === "" ? "none" : `${x}${unit}`);

/** every changed field, each marked by whether it loosens or tightens the floor */
export function diffProfile(now: Form, next: Form, tplName: (id: string) => string): DiffRow[] {
  const rows: DiffRow[] = [];
  const push = (field: string, a: string, b: string, effect: Effect) => {
    if (a !== b) rows.push({ field, now: a, proposed: b, effect });
  };
  const ranked = (field: string, r: Record<string, number>, a: string, b: string) =>
    push(field, shown(a).replaceAll("_", " "), shown(b).replaceAll("_", " "), (r[b] ?? 0) < (r[a] ?? 0) ? "loosens" : "tightens");
  // a floor (a minimum): lowering it or removing it loosens
  const floor = (field: string, a: string, b: string, unit: string) =>
    push(field, shown(a, unit), shown(b, unit), num(b) == null || (num(a) != null && num(b)! < num(a)!) ? "loosens" : "tightens");
  // a ceiling (a maximum): raising it or removing it loosens
  const ceiling = (field: string, a: string, b: string, unit: string) =>
    push(field, shown(a, unit), shown(b, unit), num(b) == null || (num(a) != null && num(b)! > num(a)!) ? "loosens" : "tightens");
  const set = (field: string, a: string[], b: string[], label: (x: string) => string) => {
    const removed = a.some((x) => !b.includes(x));
    const fmt = (xs: string[]) => xs.map(label).join(", ") || "none";
    push(field, fmt(a), fmt(b), removed ? "loosens" : "tightens");
  };
  set("Required workflows", now.requiredTemplateIds, next.requiredTemplateIds, tplName);
  ranked("MCP default mode", RANK.mcp, now.mcpDefaultMode, next.mcpDefaultMode);
  ranked("PII mode", RANK.pii, now.piiMode, next.piiMode);
  floor("Audit retention", now.auditRetentionDays, next.auditRetentionDays, " days");
  floor("Backup retention", now.backupRetentionDays, next.backupRetentionDays, " days");
  ceiling("Patch cadence", now.patchCadenceDays, next.patchCadenceDays, " days");
  ceiling("Maximum project budget", now.maxProjectBudgetUsd, next.maxProjectBudgetUsd, " USD");
  ranked("Budget enforcement", RANK.enforcement, now.budgetEnforcement, next.budgetEnforcement);
  for (const d of DETECTORS) ranked(`Guardrail: ${d.replaceAll("_", " ")}`, RANK.guard, now.guardrailModes[d], next.guardrailModes[d]);
  set("Red-team gating classes", now.redteamGatingClasses, next.redteamGatingClasses, (x) => x.replaceAll("_", " "));
  floor("Red-team minimum trials", now.redteamMinTrials, next.redteamMinTrials, "");
  ranked("Red-team fails on severity", RANK.severity, now.redteamFailOnSeverity, next.redteamFailOnSeverity);
  ranked("Minimum isolation class", RANK.isolation, now.minIsolationClass, next.minIsolationClass);
  return rows;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export const reachSentence = (u: ProfileRecord["usage"]) =>
  andList([
    plural(u?.projects.length ?? 0, "project", "projects"),
    plural(u?.teams.length ?? 0, "team", "teams"),
    plural(u?.resources.length ?? 0, "infrastructure resource", "infrastructure resources"),
  ]);

const multi = (e: React.ChangeEvent<HTMLSelectElement>) => Array.from(e.target.selectedOptions).map((o) => o.value);

export function ProfileEditModal(props: { profile: ProfileRecord; templates: WorkflowTemplate[]; onClose: () => void }) {
  const p = props.profile;
  const initial = toForm(p);
  const [f, setF] = useState<Form>(initial);
  const [step, setStep] = useState<"form" | "review">("form");
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const act = useAction();
  const users = useUsers();
  const { auth } = useSession();
  const set = <K extends keyof Form>(k: K, val: Form[K]) => setF((x) => ({ ...x, [k]: val }));
  const tplName = (id: string) => props.templates.find((t) => t.id === id)?.name ?? id.slice(0, 8);
  const rows = diffProfile(initial, f, tplName);
  const loosens = rows.some((r) => r.effect === "loosens");
  const nextVersion = (p.version ?? 1) + 1;
  const reviewers = (users.data?.users ?? []).filter((u) => u.id !== auth?.userId && !u.disabledAt);
  const reviewerName = reviewers.find((u) => u.id === reviewer)?.displayName ?? "the reviewer";

  const send = () => {
    if (!reviewer) return setErr("Choose a reviewer — a profile change never applies without one.");
    if (reason.trim().length < 10) return setErr("Say a little more — at least 10 characters. The reviewer has only this sentence to go on.");
    setErr(null);
    void act
      .run(
        () =>
          api.post<{ pending: boolean; approvalId: string }>(`/v1/compliance/profiles/${p.id}/versions`, {
            requiredTemplateIds: f.requiredTemplateIds,
            mcpDefaultMode: f.mcpDefaultMode,
            piiMode: f.piiMode,
            auditRetentionDays: num(f.auditRetentionDays),
            backupRetentionDays: num(f.backupRetentionDays),
            patchCadenceDays: num(f.patchCadenceDays),
            maxProjectBudgetUsd: num(f.maxProjectBudgetUsd),
            budgetEnforcement: f.budgetEnforcement || null,
            guardrailModes: Object.fromEntries(Object.entries(f.guardrailModes).filter(([, m]) => m)),
            redteamGatingClasses: f.redteamGatingClasses,
            redteamMinTrials: num(f.redteamMinTrials),
            redteamFailOnSeverity: f.redteamFailOnSeverity || null,
            minIsolationClass: f.minIsolationClass || null,
            reviewerUserId: reviewer,
            reason: reason.trim(),
          }),
        `Sent to ${reviewerName} for review`,
      )
      .then((ok) => ok && props.onClose());
  };

  return (
    <Modal
      open
      wide
      title={step === "form" ? `Edit profile “${p.tag}”` : `Review the change to “${p.tag}”`}
      onClose={props.onClose}
      actions={
        step === "form" ? (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" disabled={rows.length === 0} onClick={() => setStep("review")}>
              {rows.length === 0 ? "No changes yet" : "Review change"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep("form")}>Back to edit</Button>
            <Button variant="primary" disabled={act.busy} onClick={send}>
              Send for review
            </Button>
          </>
        )
      }
    >
      {step === "form" ? (
        <div className={v.stack} data-testid="g7-edit-form">
          <p className={`${v.dim} ${v.flush}`}>
            Prefilled from version {p.version ?? 1}. Saving creates version {nextVersion}; it applies only after a reviewer approves it.
          </p>
          <div className={v.sectionTitle}>Workflows and data</div>
          <div className={a.formRow}>
            <Field label="Required workflows">
              <Select multiple size={3} value={f.requiredTemplateIds} onChange={(e) => set("requiredTemplateIds", multi(e))}>
                {props.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="MCP default mode">
              <Select value={f.mcpDefaultMode} onChange={(e) => set("mcpDefaultMode", e.target.value)}>
                <option value="read_only">read only — write tools denied</option>
                <option value="read_write">read and write</option>
              </Select>
            </Field>
            <Field label="PII mode">
              <Select value={f.piiMode} onChange={(e) => set("piiMode", e.target.value)}>
                <option value="block">block — deny or withhold</option>
                <option value="warn">warn — proceed with a warning</option>
                <option value="log">log — record category counts</option>
              </Select>
            </Field>
          </div>
          <div className={v.sectionTitle}>Retention, patching and budget</div>
          <div className={a.formRow}>
            <Field label="Audit retention (days)">
              <Input type="number" value={f.auditRetentionDays} onChange={(e) => set("auditRetentionDays", e.target.value)} />
            </Field>
            <Field label="Backup retention (days)">
              <Input type="number" value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
            </Field>
            <Field label="Patch cadence (days, at most)">
              <Input type="number" value={f.patchCadenceDays} onChange={(e) => set("patchCadenceDays", e.target.value)} />
            </Field>
            <Field label="Maximum project budget (USD)">
              <Input type="number" value={f.maxProjectBudgetUsd} onChange={(e) => set("maxProjectBudgetUsd", e.target.value)} />
            </Field>
            <Field label="Budget enforcement">
              <Select value={f.budgetEnforcement} onChange={(e) => set("budgetEnforcement", e.target.value)}>
                <option value="">no opinion</option>
                <option value="block">block</option>
                <option value="warn_only">warn only</option>
              </Select>
            </Field>
          </div>
          <div className={v.sectionTitle}>Guardrail modes (a floor for every project carrying the tag)</div>
          <div className={a.formRow}>
            {DETECTORS.map((d) => (
              <Field key={d} label={d.replaceAll("_", " ")}>
                <Select value={f.guardrailModes[d]} onChange={(e) => set("guardrailModes", { ...f.guardrailModes, [d]: e.target.value })}>
                  <option value="">no opinion</option>
                  <option value="log">log</option>
                  <option value="warn">warn</option>
                  <option value="block">block</option>
                </Select>
              </Field>
            ))}
          </div>
          <div className={v.sectionTitle}>Red-team gating and isolation</div>
          <div className={a.formRow}>
            <Field label="Gating classes">
              <Select multiple size={3} value={f.redteamGatingClasses} onChange={(e) => set("redteamGatingClasses", multi(e))}>
                {ATTACK_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Minimum trials per probe">
              <Input type="number" value={f.redteamMinTrials} onChange={(e) => set("redteamMinTrials", e.target.value)} />
            </Field>
            <Field label="Fail on severity (and above)">
              <Select value={f.redteamFailOnSeverity} onChange={(e) => set("redteamFailOnSeverity", e.target.value)}>
                {optionEls(["low", "medium", "high", "critical"].map((x) => ({ v: x, l: x })), "no opinion")}
              </Select>
            </Field>
            <Field label="Minimum isolation class">
              <Select value={f.minIsolationClass} onChange={(e) => set("minIsolationClass", e.target.value)}>
                <option value="">no opinion</option>
                <option value="hardened_container">hardened container</option>
                <option value="user_space_kernel">user-space kernel</option>
                <option value="microvm">micro VM</option>
              </Select>
            </Field>
          </div>
        </div>
      ) : (
        <div className={v.stack} data-testid="g7-edit-review">
          <p className={v.flush}>
            <strong>This change creates version {nextVersion} and needs a reviewer before it applies.</strong>
          </p>
          <Table<DiffRow>
            rows={rows}
            rowKey={(r) => r.field}
            columns={[
              { key: "field", header: "Field", render: (r) => r.field },
              { key: "now", header: "Now", render: (r) => r.now },
              {
                key: "proposed",
                header: "Proposed",
                render: (r) => (
                  <span className={v.row}>
                    {r.proposed}
                    {r.effect === "loosens" && <Badge tone="warn">loosens</Badge>}
                  </span>
                ),
              },
            ]}
          />
          <p className={`${v.dim} ${v.flush}`}>
            Affects {reachSentence(p.usage)}.
          </p>
          <div className={a.formRow}>
            <Field label="Reviewer">
              <Select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
                {optionEls(reviewers.map((u) => ({ v: u.id, l: u.displayName ?? u.email })), "— choose a reviewer —")}
              </Select>
            </Field>
            <Field label="Reason (at least 10 characters)" grow>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          {loosens && (
            <p className={`${v.dim} ${v.flush}`}>
              This change loosens {rows.filter((r) => r.effect === "loosens").length === 1 ? "a floor" : "floors"}. You will be asked to confirm it's you.
            </p>
          )}
          {(err ?? act.error) && (
            <div className={v.errLine} role="alert">
              {err ?? act.error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
