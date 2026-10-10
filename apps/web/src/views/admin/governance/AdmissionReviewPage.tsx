import { DetectionContentPanel } from "./DetectionContentPanel";
/**
 * ADR-0175 A6/A5 — ADMISSION REVIEW: one admin page for what the admission
 * detectors and the release-age waiting period are holding.
 *
 *  - Builder skills: held (admit with a reason), blocked (the owner edits it),
 *    and requests to share a skill with the workspace (approve or deny).
 *  - Waiting period: `min_release_age_days` (0 = off; 7 recommended), and the
 *    MCP servers and skill versions it is holding, each with "Allow now" (an
 *    audited, per-item override with a reason).
 *  - MCP servers held by the ADR-0097 manifest scan, read-only here (they are
 *    cleared from the MCP servers page's existing flow).
 *
 * Findings are counts and locations only — the gateway never sends the matched
 * text, so this page cannot become a delivery vector for what it reviews.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AdmissionFindingCount, SkillAdmissionState } from "../../../api/types";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Table } from "../../../ui/kit";
import { ReasonModal, useAction } from "../adminKit";
import v from "../../views.module.css";
import { putOrgSettings, api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

interface ReviewSkill {
  id: string;
  name: string;
  ownerName: string | null;
  visibility: "private" | "workspace";
  requestedVisibility: "private" | "workspace" | null;
  version: number;
  contentDigest: string;
  admissionState: SkillAdmissionState;
  admissionSeverity: AdmissionFindingCount["severity"] | null;
  admissionFindings: AdmissionFindingCount[];
  admittedAt: string | null;
  admitReason: string | null;
}
interface SkillQueue {
  scannerVersion: string;
  holdAt: string;
  refuseAt: string;
  rules: string[];
  skills: ReviewSkill[];
}
interface QuarantineItem {
  id: string;
  name: string;
  firstSeenAt: string;
  ageDays: number;
  readyAt: string | null;
  quarantined: boolean;
  admissionState: string;
  version?: number;
  origin?: string;
  /** a server's release: its manifest digest, or `registration` */
  release?: string;
  /** a skill version's content digest */
  digest?: string;
}
interface Quarantine {
  enabled: boolean;
  minReleaseAgeDays: number;
  recommendedDays: number;
  servers: QuarantineItem[];
  skills: QuarantineItem[];
}
interface McpQueue {
  mode: string;
  enforcing: boolean;
  servers: Array<{ id: string; name: string; admissionState: string; admissionSeverity: string | null; admissionFindings: AdmissionFindingCount[] | null }>;
}

const KEY = ["admin", "admission-review"] as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const findingText = (f: AdmissionFindingCount[]) =>
  f.length ? f.map((x) => `${x.rule} in ${x.where} (${x.severity}, ×${x.count})`).join("; ") : "no findings recorded";

const STATE_TONE: Record<string, "warn" | "danger" | "ok" | "neutral"> = {
  held: "warn",
  refused: "danger",
  admitted: "ok",
};

type Pending =
  | { kind: "admit"; skill: ReviewSkill }
  | { kind: "deny-share"; skill: ReviewSkill }
  | { kind: "override"; item: QuarantineItem; target: "mcp_server" | "skill" };

export default function AdmissionReviewPage() {
  const skills = useQuery({ queryKey: [...KEY, "skills"], queryFn: () => api.get<SkillQueue>("/v1/admission/skills") });
  const quarantine = useQuery({ queryKey: [...KEY, "quarantine"], queryFn: () => api.get<Quarantine>("/v1/release-quarantine") });
  const mcp = useQuery({ queryKey: [...KEY, "mcp"], queryFn: () => api.get<McpQueue>("/v1/mcp/admission") });
  const act = useAction();
  const [pending, setPending] = useState<Pending | null>(null);

  const held = (skills.data?.skills ?? []).filter((k) => k.admissionState === "held" || k.admissionState === "refused" || k.admissionState === "admitted");
  const shares = (skills.data?.skills ?? []).filter((k) => k.requestedVisibility === "workspace");
  const heldServers = (mcp.data?.servers ?? []).filter((x) => x.admissionState === "held");

  const confirm = (reason: string) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "admit") {
      // the digest of the content this page SHOWED: if the skill changed since,
      // the gateway refuses (409) instead of admitting text nobody reviewed
      void act.run(
        () => withStepUp((h) => stepUpApi.post(`/v1/admission/skills/${p.skill.id}/admit`, { digest: p.skill.contentDigest, reason }, h)),
        `Admitted ${p.skill.name}`,
      );
    } else if (p.kind === "deny-share") {
      void act.run(() => api.post(`/v1/admission/skills/${p.skill.id}/visibility`, { decision: "deny", reason }), `Sharing denied for ${p.skill.name}`);
    } else {
      void act.run(
        () =>
          withStepUp((h) =>
            stepUpApi.post("/v1/release-quarantine/override", {
              kind: p.target,
              id: p.item.id,
              // the release this page showed (a newer one is refused with 409)
              digest: (p.target === "mcp_server" ? p.item.release : p.item.digest) ?? "",
              reason,
            }, h),
          ),
        `${p.item.name} allowed now`,
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Admission review"
        sub="Skills the admission detectors flagged, requests to share a skill, and what the waiting period is holding."
        info={
          <p>
            Every builder skill is checked when it is created, imported or edited, and again on the scheduled re-scan. A
            flagged skill can't be attached or used until you admit it here with a reason. Sharing a skill with the whole
            workspace also needs your approval. With a waiting period on, a newly registered MCP server, a changed
            manifest, a registry import and a new skill version wait until this deployment has known that exact version
            for the set number of days.
          </p>
        }
      />
      <div className={v.stack}>
        <DetectionContentPanel />
        <WaitingPeriodCard q={quarantine.data} onOverride={(item, target) => setPending({ kind: "override", item, target })} loading={quarantine.isLoading} />

        <Card title="Builder skills held by the admission detectors">
          <Table<ReviewSkill>
            rows={held}
            loading={skills.isLoading}
            error={skills.error}
            onRetry={() => void skills.refetch()}
            rowKey={(k) => k.id}
            empty={<EmptyState title="Nothing held" body="No skill is waiting for review." />}
            columns={[
              { key: "name", header: "Skill", render: (k) => <span>{k.name} <span className={v.dim}>v{k.version}</span></span> },
              { key: "owner", header: "Owner", render: (k) => k.ownerName ?? "—" },
              { key: "state", header: "State", render: (k) => <Badge tone={STATE_TONE[k.admissionState] ?? "neutral"}>{k.admissionState}</Badge> },
              { key: "findings", header: "Findings", render: (k) => <span className={v.dim}>{findingText(k.admissionFindings)}</span> },
              {
                key: "act",
                header: "",
                render: (k) =>
                  k.admissionState === "held" ? (
                    <Button size="sm" disabled={act.busy} onClick={() => setPending({ kind: "admit", skill: k })} aria-label={`Admit ${k.name}`}>
                      Admit…
                    </Button>
                  ) : k.admissionState === "admitted" ? (
                    <span className={v.dim} title={k.admitReason ?? ""}>admitted {day(k.admittedAt)}</span>
                  ) : (
                    <span className={v.dim}>owner must edit it</span>
                  ),
              },
            ]}
          />
        </Card>

        <Card title="Requests to share a skill with the workspace">
          <Table<ReviewSkill>
            rows={shares}
            loading={skills.isLoading}
            rowKey={(k) => k.id}
            empty={<EmptyState title="No requests" body="Nobody is waiting to share a skill." />}
            columns={[
              { key: "name", header: "Skill", render: (k) => k.name },
              { key: "owner", header: "Owner", render: (k) => k.ownerName ?? "—" },
              { key: "state", header: "Scan", render: (k) => <Badge tone={STATE_TONE[k.admissionState] ?? "neutral"}>{k.admissionState}</Badge> },
              {
                key: "act",
                header: "",
                render: (k) => (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={act.busy}
                      aria-label={`Approve sharing ${k.name}`}
                      onClick={() => void act.run(() => api.post(`/v1/admission/skills/${k.id}/visibility`, { decision: "approve" }), `${k.name} shared with the workspace`)}
                    >
                      Approve
                    </Button>
                    <Button size="sm" disabled={act.busy} aria-label={`Deny sharing ${k.name}`} onClick={() => setPending({ kind: "deny-share", skill: k })}>
                      Deny…
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </Card>

        <Card title="MCP servers held by the manifest scan">
          <p className={v.dim} style={{ marginTop: 0 }}>
            Mode: {mcp.data?.mode ?? "…"}
            {mcp.data && !mcp.data.enforcing ? " — recorded only, nothing is refused." : ""} Clear a server from the MCP servers page.
          </p>
          <Table
            rows={heldServers}
            loading={mcp.isLoading}
            rowKey={(x) => x.id}
            empty={<EmptyState title="Nothing held" body="No MCP server is held by the manifest scan." />}
            columns={[
              { key: "name", header: "Server", render: (x) => x.name },
              { key: "sev", header: "Severity", render: (x) => x.admissionSeverity ?? "—" },
              { key: "findings", header: "Findings", render: (x) => <span className={v.dim}>{findingText(x.admissionFindings ?? [])}</span> },
            ]}
          />
        </Card>
      </div>
      <ReasonModal
        open={pending !== null}
        title={
          pending?.kind === "admit"
            ? `Admit ${pending.skill.name}?`
            : pending?.kind === "deny-share"
              ? `Deny sharing ${pending.skill.name}?`
              : `Allow ${pending?.kind === "override" ? pending.item.name : ""} now?`
        }
        body={
          pending?.kind === "admit" ? (
            <p style={{ margin: 0 }}>
              Version {pending.skill.version} (content {pending.skill.contentDigest.slice(0, 12)}). Findings:{" "}
              {findingText(pending.skill.admissionFindings)}. Admitting covers this exact content only; if it changed after
              this page loaded, nothing is admitted and you are asked to review the new content.
            </p>
          ) : pending?.kind === "override" ? (
            <p style={{ margin: 0 }}>
              Skips the rest of the waiting period for this release only (
              {(pending.target === "mcp_server" ? pending.item.release : pending.item.digest)?.slice(0, 12) ?? "unknown"}). A
              later change starts its own waiting period.
            </p>
          ) : undefined
        }
        confirmLabel={pending?.kind === "admit" ? "Admit" : pending?.kind === "deny-share" ? "Deny" : "Allow now"}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

function WaitingPeriodCard(props: {
  q: Quarantine | undefined;
  loading: boolean;
  onOverride: (item: QuarantineItem, target: "mcp_server" | "skill") => void;
}) {
  const { q } = props;
  const act = useAction();
  const [days, setDays] = useState<string>("");
  // ADR-0181: the shipped default is 7 days, so the not-yet-loaded fallback is too
  const current = q?.minReleaseAgeDays ?? 7;
  const value = days === "" ? String(current) : days;
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 0 && n <= 365;
  const rows = [
    ...(q?.servers ?? []).map((x) => ({ ...x, target: "mcp_server" as const, what: x.origin === "federated" ? "Registry import" : "MCP server" })),
    ...(q?.skills ?? []).map((x) => ({ ...x, target: "skill" as const, what: `Skill v${x.version ?? 1}` })),
  ];
  return (
    <Card title="Waiting period for new releases">
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Days to wait (0 = off)" help={`Recommended: ${q?.recommendedDays ?? 7} days. Age counts from when this deployment first saw that exact version, never a publish date.`}>
          <Input
            type="number"
            min={0}
            max={365}
            value={value}
            aria-label="Minimum release age in days"
            onChange={(e) => setDays(e.target.value)}
            style={{ width: 120 }}
          />
        </Field>
        <Button
          variant="primary"
          disabled={!valid || n === current || act.busy}
          onClick={() =>
            void act
              .run(() => putOrgSettings({ minReleaseAgeDays: n }), n === 0 ? "Waiting period off" : `Waiting period set to ${n} days`)
              .then(() => setDays(""))
          }
        >
          Save
        </Button>
        {current === 0 && (
          <Button onClick={() => setDays(String(q?.recommendedDays ?? 7))} disabled={act.busy}>
            Use recommended ({q?.recommendedDays ?? 7})
          </Button>
        )}
      </div>
      {q && q.enabled && (
        <Table
          rows={rows}
          loading={props.loading}
          rowKey={(x) => `${x.target}:${x.id}`}
          empty={<EmptyState title="Nothing waiting" body="Nothing new is inside the waiting period." />}
          columns={[
            { key: "what", header: "Kind", render: (x) => x.what },
            { key: "name", header: "Name", render: (x) => x.name },
            { key: "seen", header: "First seen", render: (x) => day(x.firstSeenAt) },
            { key: "ready", header: "Usable from", render: (x) => day(x.readyAt) },
            {
              key: "act",
              header: "",
              render: (x) => (
                <Button size="sm" aria-label={`Allow ${x.name} now`} onClick={() => props.onOverride(x, x.target)}>
                  Allow now…
                </Button>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
