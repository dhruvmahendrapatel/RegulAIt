/**
 * ADR-0173 batch 2b — Prompts: the governed prompt registry.
 *
 * A prompt is a history of COMMITS (template, model, variables, output schema,
 * tools), each named by its content hash, with tags (`staging`, `prod`, …)
 * pointing at commits. Moving `prod` goes to the approvals queue, and the
 * approver may not be the commit's author. Visibility follows the builder
 * model: only me, the workspace, or named people (admins see everything).
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, EmptyState, ErrorState, Field, Input, Modal, Select, SkeletonBlock, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { useDirectory, useMyProjects } from "./builderApi";
import { ChoiceCards, Icon, Segmented } from "./BuilderUi";
import { pk, promptsApi, type PromptSummary, type PromptVisibility } from "./promptsApi";
import { PROD_TAG, shortHash } from "./promptsLogic";
import s from "./builder.module.css";
import p from "./prompts.module.css";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const VISIBILITY_LABEL: Record<PromptVisibility, string> = {
  private: "Only me",
  workspace: "Workspace",
  people: "Specific people",
};

/** visibility + named people, shared by the New prompt dialog and the detail page */
export function PromptSharingFields(props: {
  visibility: PromptVisibility;
  onVisibility: (v: PromptVisibility) => void;
  people: string[];
  onPeople: (ids: string[]) => void;
  ownerUserId: string | null;
  disabled?: boolean;
}) {
  const directory = useDirectory();
  const [pick, setPick] = useState("");
  const users = directory.data?.users ?? [];
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const choosable = users.filter((u) => u.id !== props.ownerUserId && !props.people.includes(u.id));
  return (
    <>
      <ChoiceCards<PromptVisibility>
        legend="Who can see it"
        value={props.visibility}
        onChange={props.onVisibility}
        disabled={props.disabled}
        options={[
          { value: "private", title: "Only me", sub: "You and admins.", icon: Icon.lock(16) },
          { value: "workspace", title: "Workspace", sub: "Everyone can read it and run it in the playground.", icon: Icon.globe() },
          { value: "people", title: "Specific people", sub: "Only the people you add below.", icon: Icon.users() },
        ]}
      />
      {props.visibility === "people" && (
        <>
          {props.people.length > 0 && (
            <ul className={s.list} aria-label="Shared with" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {props.people.map((id) => (
                <li key={id} className={s.listRow}>
                  <span className={s.listRowMain}>
                    <span className={s.listRowTitle}>{nameOf(id)}</span>
                  </span>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Stop sharing with ${nameOf(id)}`}
                    disabled={props.disabled}
                    onClick={() => props.onPeople(props.people.filter((x) => x !== id))}
                  >
                    {Icon.close(14)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={s.toolbar} style={{ margin: 0 }}>
            <Select aria-label="Person to share with" value={pick} onChange={(e) => setPick(e.target.value)} disabled={props.disabled} style={{ flex: 1 }}>
              <option value="">Choose a person</option>
              {choosable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.id}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={props.disabled || !pick}
              onClick={() => {
                props.onPeople([...props.people, pick]);
                setPick("");
              }}
            >
              Add
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function NewPromptDialog(props: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { auth } = useSession();
  const projects = useMyProjects();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<PromptVisibility>("private");
  const [people, setPeople] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      promptsApi.create({
        name: name.trim(),
        description: description.trim(),
        visibility,
        sharedUserIds: visibility === "people" ? people : [],
        projectId: projectId || null,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: pk.prompts });
      toast(`Prompt ${res.prompt.name} created — write its first commit in the playground`, "success");
      props.onClose();
      navigate(`/builder/prompts/${res.prompt.id}`);
    },
    onError: (e) => setError(errText(e)),
  });
  return (
    <Modal
      open={props.open}
      title="New prompt"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create prompt"}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. use-case-summary" />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} placeholder="What this prompt is for" />
      </Field>
      <Field label="Project (optional)">
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">No project</option>
          {(projects.data?.projects ?? []).map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.name}
            </option>
          ))}
        </Select>
      </Field>
      <PromptSharingFields visibility={visibility} onVisibility={setVisibility} people={people} onPeople={setPeople} ownerUserId={auth?.userId ?? null} />
      {error && (
        <p role="alert" className={p.err}>
          {error}
        </p>
      )}
    </Modal>
  );
}

function TagBadges({ tags }: { tags: PromptSummary["tags"] }) {
  return (
    <>
      {tags.map((t) => (
        <Badge key={t.name} tone={t.name === PROD_TAG ? "ok" : "info"} title={`${t.name} → ${t.commitHash}`}>
          {t.name} · {shortHash(t.commitHash).slice(0, 7)}
        </Badge>
      ))}
    </>
  );
}

export default function BuilderPromptsPage() {
  const prompts = useQuery({ queryKey: pk.prompts, queryFn: promptsApi.list });
  const { auth } = useSession();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [creating, setCreating] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (prompts.data?.prompts ?? []).filter(
      (r) => (scope === "all" || r.ownerUserId === auth?.userId) && (!q || `${r.name} ${r.description}`.toLowerCase().includes(q)),
    );
  }, [prompts.data, query, scope, auth?.userId]);

  return (
    <>
      <PageHeader
        title="Prompts"
        crumbs={["Agent builder"]}
        sub="Versioned prompts with tags. Moving prod needs another person's approval."
        info={
          <p>
            Every change to a prompt is a commit named by a hash of its content: the template, the model, the variables, the output schema and the tools.
            Tags such as staging and prod point at commits. Other tags move straight away; moving prod goes to the approvals queue, and the person who
            approves it can&apos;t be the commit&apos;s author.
          </p>
        }
        actions={
          <div className={s.toolbar} style={{ margin: 0 }}>
            <Link to="/builder/playground" className={s.helpLink}>
              Open the playground
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {Icon.plus()} New prompt
            </Button>
          </div>
        }
      />
      <div className={s.toolbar}>
        <Input className={s.search} type="search" aria-label="Search prompts" placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span style={{ flex: 1 }} />
        <Segmented
          label="Show"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All I can see" },
            { value: "mine", label: "Only mine" },
          ]}
        />
      </div>
      {prompts.isLoading ? (
        <div className={s.glass} style={{ padding: 24 }}>
          <SkeletonBlock lines={4} />
        </div>
      ) : prompts.isError ? (
        <div className={s.glass}>
          <ErrorState title="Couldn't load prompts" message={errText(prompts.error)} onRetry={() => void prompts.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <div className={s.glass}>
          {query || scope !== "all" ? (
            <EmptyState title="No matching prompts" body="Try a different search or filter." />
          ) : (
            <EmptyState
              title="No prompts yet"
              body="Create a prompt, try it in the playground, and save the version that works as a commit."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New prompt
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <ul className={s.skillGrid} aria-label="Prompts" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {list.map((r) => (
            <li key={r.id} style={{ display: "flex" }}>
              <Link to={`/builder/prompts/${r.id}`} className={p.cardLink} style={{ flex: 1 }} aria-label={`Open prompt ${r.name}`}>
                <span className={p.cardName}>{r.name}</span>
                <span className={`${s.muted} ${s.clamp2}`}>{r.description || "No description."}</span>
                <span className={p.facts} style={{ marginTop: "auto", paddingTop: 6 }}>
                  <Badge tone={r.visibility === "private" ? "neutral" : "primary"}>{VISIBILITY_LABEL[r.visibility]}</Badge>
                  <TagBadges tags={r.tags} />
                  {r.latestCommitHash ? (
                    <span>
                      latest <span className={p.hash}>{shortHash(r.latestCommitHash).slice(0, 7)}</span> · {ago(r.latestCommitAt)}
                    </span>
                  ) : (
                    <span>no commits yet</span>
                  )}
                  {r.ownerUserId !== auth?.userId && <span>by {r.ownerName ?? "someone else"}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewPromptDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
