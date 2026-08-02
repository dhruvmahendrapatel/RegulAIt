/**
 * ADR-0054 — the first-run wizard.
 *
 * DELIBERATELY NOT the same page as Getting started (`/admin/setup`). That page
 * is a read-only mirror of live readiness signals: it tells you what IS true and
 * links you at the view that would change it. This one is the ORDERED, RESUMABLE
 * flow that gets a new deployment from "installed" to "governing", and it acts —
 * it seeds roles, applies a compliance pack, imports a directory.
 *
 * Two things this page shows that a checklist normally hides:
 *
 *  - `status` (what an admin RECORDED) and `satisfied` (what the deployment
 *    currently SAYS) are rendered as separate signals. When they disagree the
 *    row is flagged `drift` — a step someone ticked whose provider was later
 *    deleted reads honestly instead of staying green.
 *  - Every mutation is idempotent server-side, so the Re-run button is safe and
 *    is labelled as such. An admin who closes the tab mid-install comes back to
 *    `resumeAt` pointing at the step that was in flight.
 *
 * IMPORT IS DRY-RUN FIRST, ALWAYS. The preview and the apply are computed by the
 * same server-side planner, so what this page shows is what will happen. A
 * payload that tries to carry `isAdmin` is refused by the gateway with a named
 * rule id, and this page surfaces that refusal verbatim rather than reducing it
 * to "import failed".
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, Field, Meter, Select, Textarea } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";

interface WizardStep {
  key: string;
  title: string;
  why: string;
  requires: string[];
  status: "pending" | "in_progress" | "done" | "skipped";
  satisfied: boolean;
  drift: boolean;
  evidence: Record<string, unknown>;
  blockedBy: string[];
  completedAt: string | null;
}
interface WizardResponse {
  steps: WizardStep[];
  resumeAt: string | null;
  complete: boolean;
  doneCount: number;
  satisfiedCount: number;
  totalCount: number;
  packs: Array<{ tag: string; label: string; summary: string }>;
  starterRoles: Array<{ name: string; description: string }>;
}

/** where each step is actually completed, so the flow never dead-ends */
const DEEP_LINK: Record<string, { to: string; cta: string }> = {
  connect_idp: { to: "/admin/sso", cta: "Configure SSO" },
  import_users: { to: "/admin/users", cta: "Open Users" },
  seed_roles: { to: "/admin/roles", cta: "Open Roles" },
  connect_model_provider: { to: "/admin/model-credentials", cta: "Add a credential" },
  compliance_pack: { to: "/admin/compliance", cta: "Open Compliance" },
  first_governed_call: { to: "/chat", cta: "Open Chat" },
};

const tone = (s: WizardStep) =>
  s.status === "done" ? (s.drift ? "warn" : "ok") : s.status === "skipped" ? "neutral" : s.status === "in_progress" ? "warn" : "neutral";

export default function FirstRunPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["onboarding"], queryFn: () => api.get<WizardResponse>("/v1/onboarding") });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["onboarding"] });

  const [pack, setPack] = useState("soc2");
  const [csv, setCsv] = useState("email,displayName,groups\n");
  const [importResult, setImportResult] = useState<unknown>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const setStatus = useMutation({
    mutationFn: (args: { key: string; status: string }) =>
      api.post(`/v1/onboarding/steps/${encodeURIComponent(args.key)}`, { status: args.status }),
    onSuccess: invalidate,
  });
  const seedRoles = useMutation({
    mutationFn: () => api.post("/v1/onboarding/roles/seed", { mode: "apply" }),
    onSuccess: invalidate,
  });
  const applyPack = useMutation({
    mutationFn: () => api.post("/v1/onboarding/compliance-pack", { pack, mode: "apply" }),
    onSuccess: invalidate,
  });
  const runImport = useMutation({
    mutationFn: (mode: "dry_run" | "apply") =>
      api.post<unknown>("/v1/onboarding/imports/users", { mode, csv }),
    onSuccess: (r) => {
      setImportError(null);
      setImportResult(r);
      invalidate();
    },
    onError: (e: unknown) => {
      setImportResult(null);
      setImportError(e instanceof Error ? e.message : String(e));
    },
  });

  const d = q.data;
  return (
    <>
      <PageHeader
        title="First-run setup"
        sub="The ordered path from installed to governing. Resumable — leave and come back; every step is idempotent, so re-running one reconciles rather than duplicates. This is the in-product setup; bringing the deployment itself up is the installer's job."
        actions={
          <Button size="sm" onClick={() => void q.refetch()}>
            Re-check
          </Button>
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && (
          <div className={v.stack}>
            <Card>
              <div className={v.row}>
                <span className={v.statValue}>
                  {d.doneCount} / {d.totalCount}
                </span>
                <span className={v.statLabel}>steps recorded done</span>
                <Badge tone={d.satisfiedCount === d.totalCount ? "ok" : "warn"}>
                  {d.satisfiedCount} / {d.totalCount} verified live
                </Badge>
                {d.resumeAt && <Badge tone="warn">resume at: {d.resumeAt.replaceAll("_", " ")}</Badge>}
              </div>
              <div style={{ margin: "var(--s2) 0" }}>
                <Meter value={d.satisfiedCount} max={d.totalCount} label="verified setup progress" />
              </div>
              <p className={v.faint}>
                Two numbers, deliberately. The first is what an admin recorded; the second is what the
                deployment currently says when asked. A step marked done whose provider was later removed
                shows as drift rather than staying green.
              </p>
            </Card>

            {d.steps.map((s) => {
              const link = DEEP_LINK[s.key];
              const blocked = s.blockedBy.length > 0;
              return (
                <Card key={s.key}>
                  <div className={v.row}>
                    <strong style={{ fontSize: "var(--text-sm)" }}>{s.title}</strong>
                    <Badge tone={tone(s)}>{s.status.replaceAll("_", " ")}</Badge>
                    <Badge tone={s.satisfied ? "ok" : "neutral"}>
                      {s.satisfied ? "verified live" : "not verified"}
                    </Badge>
                    {s.drift && <Badge tone="danger">drift</Badge>}
                    {blocked && <Badge tone="warn">blocked by {s.blockedBy.join(", ")}</Badge>}
                  </div>
                  <div className={v.dim}>{s.why}</div>
                  <div className={v.faint}>
                    <code>{JSON.stringify(s.evidence)}</code>
                  </div>
                  <div className={v.row} style={{ marginTop: "var(--s2)" }}>
                    {link && (
                      <Link to={link.to}>
                        <Button size="sm">{link.cta}</Button>
                      </Link>
                    )}
                    <Button
                      size="sm"
                      disabled={blocked || setStatus.isPending}
                      onClick={() => setStatus.mutate({ key: s.key, status: "done" })}
                    >
                      Mark done
                    </Button>
                    <Button
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ key: s.key, status: "in_progress" })}
                    >
                      Mark in progress
                    </Button>
                    <Button
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ key: s.key, status: "skipped" })}
                    >
                      Skip
                    </Button>
                  </div>

                  {s.key === "seed_roles" && (
                    <div style={{ marginTop: "var(--s2)" }}>
                      <Button size="sm" disabled={seedRoles.isPending} onClick={() => seedRoles.mutate()}>
                        Seed starter roles (safe to re-run)
                      </Button>
                      <div className={v.faint}>
                        {d.starterRoles.map((r) => r.name).join(" · ")} — created with NO grants. A governance
                        product must not ship a default-allow, so you attach access in the role builder. There is
                        no &ldquo;Admin&rdquo; template: platform admin is a per-user flag no role can confer.
                      </div>
                    </div>
                  )}

                  {s.key === "compliance_pack" && (
                    <div style={{ marginTop: "var(--s2)" }}>
                      <Field label="Compliance pack">
                        <Select value={pack} onChange={(e) => setPack(e.target.value)}>
                          {d.packs.map((p) => (
                            <option key={p.tag} value={p.tag}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <div className={v.faint}>{d.packs.find((p) => p.tag === pack)?.summary}</div>
                      <Button size="sm" disabled={applyPack.isPending} onClick={() => applyPack.mutate()}>
                        Apply pack (safe to re-run)
                      </Button>
                      <div className={v.faint}>
                        A pack is a cascade seed, not a new mechanism, and never a certification. It composes
                        strictest-wins with your org and project settings, so it can only raise a floor.
                        Classify a project with the tag to make the cascade live.
                      </div>
                    </div>
                  )}

                  {s.key === "import_users" && (
                    <div style={{ marginTop: "var(--s2)" }}>
                      <Field label="Directory CSV (email, displayName, username, groups)">
                        <Textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} />
                      </Field>
                      <div className={v.row}>
                        <Button size="sm" disabled={runImport.isPending} onClick={() => runImport.mutate("dry_run")}>
                          Preview (changes nothing)
                        </Button>
                        <Button size="sm" disabled={runImport.isPending} onClick={() => runImport.mutate("apply")}>
                          Apply
                        </Button>
                      </div>
                      <div className={v.faint}>
                        Imported accounts are never administrators and never name a role. An
                        <code> is_admin</code> column is refused outright, audited, and recorded — not silently
                        dropped. Role membership comes from groups, resolved through mappings you authored.
                      </div>
                      {importError && <div className={v.faint}>Refused: {importError}</div>}
                      {importResult != null && (
                        <pre className={v.faint} style={{ overflowX: "auto" }}>
                          {JSON.stringify(importResult, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}

            <Card>
              <strong style={{ fontSize: "var(--text-sm)" }}>Replay this setup elsewhere</strong>
              <div className={v.dim}>
                Everything above is ordinary governed state — roles, group mappings, compliance profiles,
                classifications. There is no &ldquo;wizard mode&rdquo; representation. Export it and apply it to
                the next sovereign deployment as code instead of redoing the clicks. Users, secrets and
                platform-admin flags are deliberately excluded from the export.
              </div>
              <a href="/v1/onboarding/export" target="_blank" rel="noreferrer">
                <Button size="sm">Export configuration</Button>
              </a>
            </Card>
          </div>
        )}
      </QueryGate>
    </>
  );
}
