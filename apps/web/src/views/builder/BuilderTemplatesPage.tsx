/**
 * ADR-0172 — builder Templates: ready-made governance agents by RegulAIt. Each
 * card explains the agent before anyone creates it.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../shell/AppShell";
import { Button, EmptyState, ErrorState, SkeletonBlock } from "../../ui/kit";
import { bk, builderApi } from "./builderApi";
import { HeroArt, Icon, LogoStrip, NewAgentDialog, Segmented } from "./BuilderUi";
import s from "./builder.module.css";

export function Byline() {
  return (
    <span className={s.byline}>
      {Icon.shield(13)} by RegulAIt
    </span>
  );
}

export default function BuilderTemplatesPage() {
  const templates = useQuery({ queryKey: bk.templates, queryFn: builderApi.listTemplates });
  const [category, setCategory] = useState("all");
  const [newOpen, setNewOpen] = useState(false);
  const closeNew = useCallback(() => setNewOpen(false), []);
  const categories = useMemo(() => [...new Set((templates.data?.templates ?? []).map((t) => t.category))].sort(), [templates.data]);
  const list = (templates.data?.templates ?? []).filter((t) => category === "all" || t.category === category);

  return (
    <>
      <PageHeader title="Agent templates" crumbs={["Agent builder"]} sub="Ready-made governance agents. Open one to see exactly what it does before you create it." />
      {categories.length > 1 && (
        <div className={s.toolbar}>
          <Segmented label="Category" value={category} onChange={setCategory} options={[{ value: "all", label: "All" }, ...categories.map((c) => ({ value: c, label: c }))]} />
        </div>
      )}
      {templates.isLoading ? (
        <div className={s.glass} style={{ padding: 24 }}>
          <SkeletonBlock lines={4} />
        </div>
      ) : templates.isError ? (
        <div className={s.glass}>
          <ErrorState title="Couldn't load templates" message={(templates.error as Error).message} onRetry={() => void templates.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <div className={s.glass}>
          <EmptyState title="No templates yet" body="Templates appear here when they're available." />
        </div>
      ) : (
        <ul className={s.templateGrid} aria-label="Templates" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {list.map((t) => (
            <li key={t.id} style={{ display: "flex" }}>
              <Link to={`/builder/templates/${t.id}`} className={`${s.glass} ${s.templateCard}`} style={{ flex: 1 }}>
                <HeroArt template={t} />
                <div className={s.templateBody}>
                  <span className={s.templateIcon}>{Icon.spark(20)}</span>
                  <span style={{ minWidth: 0 }}>
                    <h2 className={s.agentName}>{t.name}</h2>
                    <span className={`${s.muted} ${s.clamp2}`}>{t.tagline}</span>
                  </span>
                </div>
                <div className={s.templateFoot}>
                  <LogoStrip keys={t.integrations.slice(0, 5)} small />
                  <Byline />
                </div>
              </Link>
            </li>
          ))}
          <li style={{ display: "flex" }}>
            <div className={s.glass} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
              <EmptyState
                icon={Icon.plus(28)}
                title="Build your own"
                body="Start from a blank agent and describe what it should do."
                action={
                  <Button variant="primary" onClick={() => setNewOpen(true)}>
                    New agent
                  </Button>
                }
              />
            </div>
          </li>
        </ul>
      )}
      <NewAgentDialog open={newOpen} onClose={closeNew} />
    </>
  );
}
