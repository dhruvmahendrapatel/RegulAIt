/**
 * ADR-0172 — builder Skills: the shared library of packaged instructions
 * (SKILL.md) that agents pull in when a task calls for them. Create and edit in
 * a drawer, or import an existing SKILL.md file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import type { BuilderSkillDetail } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, ConfirmModal, EmptyState, ErrorState, Field, Input, SkeletonBlock, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { bk, builderApi } from "./builderApi";
import { parseSkillFrontmatter } from "./builderLogic";
import { ChoiceCards, Drawer, Icon, Segmented } from "./BuilderUi";
import s from "./builder.module.css";

const STARTER = `---
name:
description: Use when …
---

# Steps

1.
`;

type Visibility = "private" | "workspace";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function SkillDrawer(props: { skillId: string | "new" | null; onClose: () => void }) {
  const isNew = props.skillId === "new";
  const id = isNew ? null : props.skillId;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const detail = useQuery({ queryKey: bk.skill(id ?? ""), queryFn: () => builderApi.getSkill(id!), enabled: !!id });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("workspace");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    if (isNew && loaded.current !== "new") {
      loaded.current = "new";
      setName("");
      setDescription("");
      setBody(STARTER);
      setVisibility("workspace");
      setError(null);
    } else if (detail.data && loaded.current !== detail.data.skill.id) {
      const k = detail.data.skill;
      loaded.current = k.id;
      setName(k.name);
      setDescription(k.description);
      setBody(k.body);
      setVisibility(k.visibility);
      setError(null);
    }
    if (props.skillId === null) loaded.current = null;
  }, [isNew, detail.data, props.skillId]);

  const ro = !!detail.data && !detail.data.skill.canEdit;
  const done = (res: { skill: BuilderSkillDetail } | unknown, msg: string) => {
    void queryClient.invalidateQueries({ queryKey: bk.skills });
    if (id) void queryClient.invalidateQueries({ queryKey: bk.skill(id) });
    toast(msg, "success");
    props.onClose();
    return res;
  };
  const save = useMutation({
    mutationFn: () =>
      id
        ? builderApi.patchSkill(id, { name: name.trim(), description: description.trim(), body, visibility })
        : builderApi.createSkill({ name: name.trim(), description: description.trim(), body, visibility }),
    onSuccess: (res) => done(res, id ? "Skill saved" : "Skill created"),
    onError: (e) => setError(errText(e)),
  });
  const del = useMutation({
    mutationFn: () => builderApi.deleteSkill(id!),
    onSuccess: (res) => done(res, "Skill deleted"),
    onError: (e) => setError(errText(e)),
  });
  const valid = name.trim().length > 0 && body.length <= 20000;

  return (
    <Drawer
      open={props.skillId !== null}
      title={isNew ? "New skill" : ro ? (detail.data?.skill.name ?? "Skill") : "Edit skill"}
      onClose={props.onClose}
      footer={
        ro ? (
          <Button onClick={props.onClose}>Close</Button>
        ) : (
          <>
            {id && (
              <Button variant="danger" onClick={() => setConfirm(true)} style={{ marginRight: "auto" }}>
                Delete
              </Button>
            )}
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : isNew ? "Create skill" : "Save skill"}
            </Button>
          </>
        )
      }
    >
      {id && detail.isLoading ? (
        <SkeletonBlock lines={6} />
      ) : id && detail.isError ? (
        <ErrorState title="Couldn't open this skill" message={errText(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          {ro && (
            <p className={s.note} style={{ margin: 0 }}>
              {Icon.lock(14)} You can read this skill and attach it to agents; only its owner can change it.
            </p>
          )}
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={ro} placeholder="e.g. Assess an AI use case" />
          </Field>
          <Field label="When to use it">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} disabled={ro} placeholder="Use when someone asks to review a new AI use case…" />
          </Field>
          <ChoiceCards<Visibility>
            legend="Who can use it"
            value={visibility}
            onChange={setVisibility}
            disabled={ro}
            options={[
              { value: "workspace", title: "Workspace", sub: "Anyone can attach it to their agents.", icon: Icon.globe() },
              { value: "private", title: "Only me", sub: "Only your agents can use it.", icon: Icon.lock(16) },
            ]}
          />
          <Field label="SKILL.md" error={body.length > 20000 ? "Use 20,000 characters or fewer" : null}>
            <Textarea className={s.bodyEditor} value={body} onChange={(e) => setBody(e.target.value)} disabled={ro} spellCheck={false} />
          </Field>
          {error && (
            <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
              {error}
            </p>
          )}
        </>
      )}
      <ConfirmModal
        open={confirm}
        title="Delete this skill?"
        body="Agents using it lose it. This can't be undone."
        confirmLabel="Delete skill"
        danger
        onConfirm={() => {
          setConfirm(false);
          del.mutate();
        }}
        onCancel={() => setConfirm(false)}
      />
    </Drawer>
  );
}

export default function BuilderSkillsPage() {
  const [params, setParams] = useSearchParams();
  const skills = useQuery({ queryKey: bk.skills, queryFn: builderApi.listSkills });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "workspace" | "private">("all");
  const [open, setOpen] = useState<string | "new" | null>(params.get("new") === "1" ? "new" : null);
  const close = useCallback(() => {
    setOpen(null);
    if (params.has("new")) setParams({}, { replace: true });
  }, [params, setParams]);
  const fileRef = useRef<HTMLInputElement>(null);

  const importSkill = useMutation({
    mutationFn: (markdown: string) => builderApi.importSkill(markdown),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: bk.skills });
      toast(`Imported ${res.skill.name}`, "success");
    },
    onError: (e) => toast(errText(e), "error"),
  });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    if (fileRef.current) fileRef.current.value = "";
    if (!parseSkillFrontmatter(text)) {
      toast("This file has no name in its frontmatter. A SKILL.md starts with --- then name: and description: lines.", "error");
      return;
    }
    importSkill.mutate(text);
  };

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills.data?.skills ?? []).filter(
      (k) => (scope === "all" || k.visibility === scope) && (!q || `${k.name} ${k.description}`.toLowerCase().includes(q)),
    );
  }, [skills.data, query, scope]);

  return (
    <>
      <PageHeader
        title="Skill library"
        crumbs={["Agent builder"]}
        sub="Packaged instructions any agent can pull in when a task calls for them."
        actions={
          <div className={s.toolbar} style={{ margin: 0 }}>
            <Button onClick={() => fileRef.current?.click()} disabled={importSkill.isPending}>
              {Icon.upload()} {importSkill.isPending ? "Importing…" : "Import SKILL.md"}
            </Button>
            <Button variant="primary" onClick={() => setOpen("new")}>
              {Icon.plus()} New skill
            </Button>
          </div>
        }
      />
      <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className={s.srOnly} tabIndex={-1} aria-label="SKILL.md file" onChange={(e) => void onFile(e.target.files?.[0])} />
      <div className={s.toolbar}>
        <Input className={s.search} type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span style={{ flex: 1 }} />
        <Segmented
          label="Show"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All" },
            { value: "workspace", label: "Workspace" },
            { value: "private", label: "Only mine" },
          ]}
        />
      </div>
      {skills.isLoading ? (
        <div className={s.glass} style={{ padding: 24 }}>
          <SkeletonBlock lines={4} />
        </div>
      ) : skills.isError ? (
        <div className={s.glass}>
          <ErrorState title="Couldn't load skills" message={errText(skills.error)} onRetry={() => void skills.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <div className={s.glass}>
          {query || scope !== "all" ? (
            <EmptyState title="No matching skills" body="Try a different search or filter." />
          ) : (
            <EmptyState
              title="No skills yet"
              body="Write a skill once — say, how to assess a new AI use case — and attach it to any agent."
              action={
                <Button variant="primary" onClick={() => setOpen("new")}>
                  New skill
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <ul className={s.skillGrid} aria-label="Skills" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {list.map((k) => (
            <li key={k.id} style={{ display: "flex" }}>
              <button type="button" className={s.skillCard} style={{ flex: 1 }} onClick={() => setOpen(k.id)} aria-label={`Open skill ${k.name}`}>
                <span className={s.skillName}>
                  <span className={s.sectionIcon}>{Icon.spark(15)}</span>
                  {k.name}
                </span>
                <span className={`${s.muted} ${s.clamp2}`}>{k.description || "No description."}</span>
                <span className={s.agentFacts} style={{ marginTop: "auto", paddingTop: 6, fontSize: "var(--text-xs)" }}>
                  <Badge tone={k.visibility === "workspace" ? "primary" : "neutral"}>{k.visibility === "workspace" ? "Workspace" : "Only me"}</Badge>
                  <span>
                    Used by {k.usedBy} agent{k.usedBy === 1 ? "" : "s"}
                  </span>
                  <span className={s.dot} aria-hidden />
                  <span>{ago(k.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <SkillDrawer skillId={open} onClose={close} />
    </>
  );
}
