/**
 * ADR-0172 — a template, explained before it is created: what it does, a
 * diagram of its parts, the apps it expects, its skills, sub-agents,
 * schedules and full instructions, then Create agent.
 */
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { BuilderTemplate } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Button, Card, RecordError, SkeletonBlock } from "../../ui/kit";
import { Logo, hasLogo } from "../../ui/logos/Logo";
import { bk, builderApi } from "./builderApi";
import { scheduleSummary } from "./builderLogic";
import { Disclosure, Icon, LogoStrip, NewAgentDialog } from "./BuilderUi";
import { Byline } from "./BuilderTemplatesPage";
import s from "./builder.module.css";

const LOGO_NAMES: Record<string, string> = {
  gmail: "Gmail",
  gcalendar: "Google Calendar",
  gdrive: "Google Drive",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  confluence: "Confluence",
  slack: "Slack",
  teams: "Microsoft Teams",
  onedrive: "OneDrive",
  servicenow: "ServiceNow",
  pagerduty: "PagerDuty",
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  notion: "Notion",
  linear: "Linear",
  okta: "Okta",
  splunk: "Splunk",
  datadog: "Datadog",
  sentry: "Sentry",
  snowflake: "Snowflake",
  postgresql: "PostgreSQL",
  aws: "AWS",
  azure: "Azure",
  gcloud: "Google Cloud",
  mcp: "MCP",
  zendesk: "Zendesk",
  box: "Box",
  dropbox: "Dropbox",
};
export const logoName = (key: string) => LOGO_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

/** the agent's anatomy as a small diagram; decorative — every part is listed in text below */
function AgentDiagram(props: { template: BuilderTemplate }) {
  const t = props.template;
  const boxes: Array<{ title: string; items: string[] }> = [
    { title: "Tools", items: t.integrations.map(logoName) },
    { title: "Sub-agents", items: t.subagents.map((x) => x.name) },
    { title: "Skills", items: t.skills.map((x) => x.name) },
  ].filter((b) => b.items.length > 0);
  const h = 260;
  const boxH = (n: number) => 30 + Math.min(n, 4) * 16;
  let y = 16;
  const placed = boxes.map((b) => {
    const at = y;
    y += boxH(b.items.length) + 14;
    return { ...b, y: at };
  });
  const total = Math.max(h, y);
  const cy = total / 2;
  const ink = { fill: "var(--rg-ink)" };
  const muted = { fill: "var(--rg-ink-label)" };
  return (
    <div className={s.diagram} aria-hidden>
      <svg viewBox={`0 0 440 ${total}`}>
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" style={{ stroke: "var(--rg-line)" }} />
          </pattern>
        </defs>
        <rect width="440" height={total} fill="url(#grid)" />
        <g>
          <rect x="16" y={cy - 44} width="150" height="88" rx="10" style={{ fill: "var(--rg-surface)", stroke: "var(--rg-line-strong)" }} />
          <text x="30" y={cy - 22} fontSize="10" style={muted}>
            Agent
          </text>
          <text x="30" y={cy - 6} fontSize="12" fontWeight="600" style={ink}>
            {t.name.length > 20 ? `${t.name.slice(0, 19)}…` : t.name}
          </text>
          <rect x="30" y={cy + 6} width="120" height="5" rx="2.5" style={{ fill: "var(--rg-line-strong)" }} />
          <rect x="30" y={cy + 16} width="96" height="5" rx="2.5" style={{ fill: "var(--rg-line-strong)" }} />
          <rect x="30" y={cy + 26} width="108" height="5" rx="2.5" style={{ fill: "var(--rg-line)" }} />
        </g>
        {placed.map((b) => {
          const by = b.y + boxH(b.items.length) / 2;
          return (
            <g key={b.title}>
              <path d={`M166 ${cy} C 210 ${cy}, 210 ${by}, 250 ${by}`} fill="none" strokeDasharray="3 4" style={{ stroke: "var(--rg-signal-700)" }} />
              <circle cx="250" cy={by} r="3" style={{ fill: "var(--rg-signal-700)" }} />
              <rect x="256" y={b.y} width="168" height={boxH(b.items.length)} rx="10" style={{ fill: "var(--rg-surface)", stroke: "var(--rg-line-strong)" }} />
              <text x="270" y={b.y + 19} fontSize="10" fontWeight="600" style={muted}>
                {b.title}
              </text>
              {b.items.slice(0, 4).map((it, i) => (
                <text key={it + i} x="270" y={b.y + 37 + i * 16} fontSize="11" style={ink}>
                  {i === 3 && b.items.length > 4 ? `+${b.items.length - 3} more` : it.length > 24 ? `${it.slice(0, 23)}…` : it}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function BuilderTemplateDetailPage() {
  const { templateId = "" } = useParams();
  const q = useQuery({ queryKey: bk.template(templateId), queryFn: () => builderApi.getTemplate(templateId), enabled: !!templateId });
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [showInstr, setShowInstr] = useState(false);
  const t = q.data?.template;

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Template" crumbs={["Agent builder", "Agent templates"]} />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (q.isError || !t) {
    return (
      <>
        <PageHeader title="Template" crumbs={["Agent builder", "Agent templates"]} />
        <Card>
          <RecordError noun="template" error={q.error} onRetry={() => void q.refetch()} action={<Link className={s.helpLink} to="/builder/templates">Back to templates</Link>} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t.name}
        crumbs={["Agent builder", "Agent templates"]}
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            Create agent
          </Button>
        }
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <section className={`${s.glass} ${s.detailHero}`} aria-label="Overview">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Byline />
            <h2 className={s.detailTitle}>{t.name}</h2>
            <p style={{ margin: 0, color: "var(--rg-ink-body)", lineHeight: 1.6 }}>{t.description}</p>
            <LogoStrip keys={t.integrations} labels={Object.fromEntries(t.integrations.map((k) => [k, logoName(k)]))} size={20} />
          </div>
          <AgentDiagram template={t} />
        </section>

        {t.steps.length > 0 && (
          <Card title="What it does">
            <ul className={s.steps}>
              {t.steps.map((step, i) => (
                <li key={i}>
                  <span className={s.stepCheck}>{Icon.check(18)}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {t.integrations.length > 0 && (
          <Card title="Apps it works with">
            <p className={s.muted} style={{ marginTop: 0 }}>
              The agent can only use the ones you have access to. You add them as connections after creating it.
            </p>
            <ul className={s.catalogGrid} style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {t.integrations.map((k) => (
                <li key={k} className={s.catalogCard}>
                  <Logo name={hasLogo(k) ? k : null} label={logoName(k)} size={24} />
                  <span className={s.catalogName}>{logoName(k)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {t.skills.length > 0 && (
          <Card title="Skills">
            <ul className={s.catalogGrid} style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {t.skills.map((k) => (
                <li key={k.name} className={s.catalogCard} style={{ alignItems: "flex-start" }}>
                  <span className={s.sectionIcon}>{Icon.spark(18)}</span>
                  <span className={s.catalogMain}>
                    <span className={s.catalogName}>{k.name}</span>
                    <span className={`${s.catalogDesc} ${s.clamp2}`}>{k.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {(t.subagents.length > 0 || t.schedules.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
            {t.subagents.length > 0 && (
              <Card title="Sub-agents">
                <div className={s.list}>
                  {t.subagents.map((x) => (
                    <div key={x.name} className={s.listRow}>
                      <span className={s.sectionIcon}>{Icon.tree(16)}</span>
                      <span className={s.listRowMain}>
                        <span className={s.listRowTitle}>{x.name}</span>
                        <span className={s.listRowSub}>{x.description}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {t.schedules.length > 0 && (
              <Card title="Schedules">
                <div className={s.list}>
                  {t.schedules.map((x) => (
                    <div key={x.name} className={s.listRow}>
                      <span className={s.sectionIcon}>{Icon.clock(16)}</span>
                      <span className={s.listRowMain}>
                        <span className={s.listRowTitle}>{x.name}</span>
                        <span className={s.listRowSub}>{scheduleSummary(x.cadence, x.timeUtc)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        <Card title="Instructions">
          <Disclosure label={showInstr ? "Hide the full instructions" : "Show the full instructions"} open={showInstr} onToggle={() => setShowInstr((v) => !v)} controls="template-instructions" />
          {showInstr && (
            <pre id="template-instructions" className={s.instructionsPreview} style={{ maxHeight: "none", marginTop: 12 }}>
              {t.instructions}
            </pre>
          )}
        </Card>
      </div>
      <NewAgentDialog open={open} onClose={close} templateId={t.id} templateName={t.name} />
    </>
  );
}
