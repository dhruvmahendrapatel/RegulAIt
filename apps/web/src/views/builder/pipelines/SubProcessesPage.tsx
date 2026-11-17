/**
 * ADR-0341 follow-up (Camunda gap row 10) — the sub-process catalogue: approved, reusable lists of stages that
 * workflow templates call by pinned version.
 *
 * The task: an admin proposes a sub-process (or its next version) and names another administrator to review it. The
 * version waits in the Approvals Queue; only once it is approved is it listed for templates to call. A template keeps
 * the version it pinned until it is republished, so a new version never changes a running workflow by surprise.
 * Every rule (who may review, one pending version at a time, only approved versions callable) is enforced by the
 * gateway; this screen shows its answers.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { fmtAt, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, RecordError, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { optionEls, useAdminInvalidate, userOpts, useUsers } from "../../admin/adminKit";
import { useSession } from "../../../session/SessionContext";
import { useToast } from "../../../ui/toast";
import {
  parseStagesText,
  subProcessApi,
  subProcessKeys,
  SUB_PROCESS_STATE_LABEL,
  type SubProcessIssue,
  type SubProcessListItem,
} from "./subProcessApi";

const STARTER = JSON.stringify(
  [
    { id: "plan", type: "planning" },
    { id: "sign-off", type: "human_approval", approvers: ["requesting_user"] },
  ],
  null,
  2,
);

function StateBadge(props: { state: keyof typeof SUB_PROCESS_STATE_LABEL }) {
  const l = SUB_PROCESS_STATE_LABEL[props.state];
  return <Badge tone={l.tone}>{l.text}</Badge>;
}

/** the issues a refusal carried, or its sentence */
function refusalOf(e: unknown): { message: string; issues: SubProcessIssue[] } {
  if (e instanceof ApiError) {
    const issues = Array.isArray(e.payload.issues) ? (e.payload.issues as SubProcessIssue[]) : [];
    return { message: e.message, issues };
  }
  return { message: e instanceof Error ? e.message : "The request failed.", issues: [] };
}

/** propose a new sub-process, or the next version of one */
function ProposeModal(props: { open: boolean; onClose: () => void; fragment: { id: string; name: string } | null; initialStages: string }) {
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  const session = useSession();
  const me = session.auth?.userId ?? null;
  const users = useUsers();
  const reviewers = useMemo(() => userOpts(users.data?.users.filter((u) => u.isAdmin && !u.disabledAt && u.id !== me)), [users.data, me]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stagesText, setStagesText] = useState(props.initialStages);
  const [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; issues: SubProcessIssue[] } | null>(null);
  const parsed = parseStagesText(stagesText);
  const blocker =
    !props.fragment && !name.trim() ? "Give the sub-process a name."
    : "error" in parsed ? parsed.error
    : !reviewer ? "Choose who reviews it."
    : null;

  const submit = async () => {
    if (blocker || "error" in parsed) return;
    setBusy(true);
    setRefusal(null);
    try {
      if (props.fragment) {
        const r = await subProcessApi.proposeVersion(props.fragment.id, { stages: parsed.stages, reviewerUserId: reviewer });
        toast(`Version ${r.version.version} of ${props.fragment.name} is waiting for review`, "success");
      } else {
        await subProcessApi.create({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), stages: parsed.stages, reviewerUserId: reviewer });
        toast(`${name.trim()} is waiting for review`, "success");
      }
      invalidate();
      props.onClose();
    } catch (e) {
      setRefusal(refusalOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      wide
      title={props.fragment ? `Propose a new version of ${props.fragment.name}` : "Propose a sub-process"}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} aria-disabled={busy || blocker !== null} title={blocker ?? undefined}>
            {busy ? "Sending…" : "Send for review"}
          </Button>
        </>
      }
    >
      <p>It is listed for templates to call only after the reviewer approves it.</p>
      {!props.fragment && (
        <>
          <Field label="Name">
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="What it is for (optional)">
            <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Stages (JSON)" help="The same stages a workflow template has, without a trigger. A sub-process cannot call another one." error={"error" in parsed ? parsed.error : null}>
        <Textarea rows={12} spellCheck={false} value={stagesText} onChange={(e) => setStagesText(e.target.value)} />
      </Field>
      <Field label="Reviewer" help="An active administrator other than you. They decide it in the Approvals Queue.">
        <Select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
          {optionEls(reviewers, "Choose a reviewer")}
        </Select>
      </Field>
      {blocker && <p role="status">{blocker}</p>}
      {refusal && (
        <div role="alert">
          <p>{refusal.message}</p>
          {refusal.issues.length > 0 && (
            <ul>
              {refusal.issues.map((i, n) => (
                <li key={n}>
                  {i.stageId ? `${i.stageId}: ` : ""}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/** one sub-process: every version with its state, and the next proposal */
function DetailModal(props: { item: SubProcessListItem; onClose: () => void; onPropose: (stages: string) => void }) {
  const detail = useQuery({ queryKey: subProcessKeys.detail(props.item.id), queryFn: () => subProcessApi.detail(props.item.id) });
  const latest = detail.data?.versions[0] ?? null;
  const latestStages = useQuery({
    queryKey: [...subProcessKeys.detail(props.item.id), "version", latest?.version ?? 0],
    queryFn: () => subProcessApi.version(props.item.id, latest!.version),
    enabled: latest !== null,
  });
  const pending = detail.data?.versions.some((v) => v.state === "pending_approval") ?? false;
  return (
    <Modal
      open
      wide
      title={props.item.name}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Close</Button>
          <Button
            variant="primary"
            aria-disabled={pending || !latestStages.data}
            title={pending ? "A version is waiting for review: it is decided first" : undefined}
            onClick={() => {
              if (!pending && latestStages.data) props.onPropose(JSON.stringify(latestStages.data.version.stages, null, 2));
            }}
          >
            Propose a new version
          </Button>
        </>
      }
    >
      {props.item.description && <p>{props.item.description}</p>}
      {detail.isPending ? (
        <SkeletonBlock lines={3} />
      ) : detail.isError ? (
        <RecordError noun="sub-process" error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Table
          rows={detail.data!.versions}
          rowKey={(v) => v.id}
          columns={[
            { key: "version", header: "Version", render: (v) => `v${v.version}` },
            { key: "state", header: "State", render: (v) => <StateBadge state={v.state} /> },
            { key: "stages", header: "Stages", align: "right", render: (v) => v.stageCount },
            { key: "proposed", header: "Proposed", render: (v) => fmtAt(v.createdAt) },
            { key: "hash", header: "Content hash", render: (v) => <code>{v.contentHash.slice(0, 12)}</code> },
          ]}
        />
      )}
      {pending && (
        <p>
          A version is waiting for review. Its reviewer decides it in the <Link to="/admin/approvals">Approvals Queue</Link>.
        </p>
      )}
      {latestStages.data && (
        <details>
          <summary>Stages of v{latestStages.data.version.version}</summary>
          <pre>{JSON.stringify(latestStages.data.version.stages, null, 2)}</pre>
        </details>
      )}
    </Modal>
  );
}

export default function SubProcessesPage() {
  const list = useQuery({ queryKey: subProcessKeys.list, queryFn: subProcessApi.list });
  const [open, setOpen] = useState<SubProcessListItem | null>(null);
  const [proposing, setProposing] = useState<{ fragment: SubProcessListItem | null; stages: string } | null>(null);
  const rows = list.data?.items ?? [];
  const approved = rows.filter((r) => r.version !== null).length;

  return (
    <>
      <PageHeader
        title="Sub-process catalogue"
        crumbs={["Policies & gates", "Workflow templates"]}
        sub={list.data ? `${plural(approved, "approved sub-process", "approved sub-processes")} · ${plural(rows.length, "in all", "in all")}` : undefined}
        info={
          <p>
            Reusable lists of stages that workflow templates call by version. Each version is reviewed by another
            administrator before templates can use it, and a template keeps the version it pinned until it is
            published again.
          </p>
        }
        actions={
          <>
            <Link to="/admin/workflow-templates">Workflow templates</Link>
            <Button variant="primary" onClick={() => setProposing({ fragment: null, stages: STARTER })}>
              Propose a sub-process
            </Button>
          </>
        }
      />
      <Card>
        {list.isPending ? (
          <SkeletonBlock lines={4} />
        ) : list.isError ? (
          <RecordError noun="sub-process catalogue" error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No sub-processes yet"
            body="Propose one to reuse the same review, check or sign-off steps across templates."
            action={
              <Button variant="primary" onClick={() => setProposing({ fragment: null, stages: STARTER })}>
                Propose a sub-process
              </Button>
            }
          />
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r)}
            rowLabel={(r) => `Open ${r.name}`}
            columns={[
              { key: "name", header: "Name", sort: (r) => r.name.toLowerCase(), render: (r) => r.name },
              { key: "description", header: "What it is for", render: (r) => r.description ?? "—" },
              { key: "version", header: "Templates can call", render: (r) => (r.version !== null ? `v${r.version} · ${plural(r.stageCount ?? 0, "stage")}` : "Nothing approved yet") },
              { key: "latest", header: "Latest version", render: (r) => (r.latest ? <>v{r.latest.version} <StateBadge state={r.latest.state} /></> : "—") },
            ]}
          />
        )}
      </Card>
      {open && (
        <DetailModal
          item={open}
          onClose={() => setOpen(null)}
          onPropose={(stages) => {
            setProposing({ fragment: open, stages });
            setOpen(null);
          }}
        />
      )}
      {proposing && (
        <ProposeModal
          open
          fragment={proposing.fragment ? { id: proposing.fragment.id, name: proposing.fragment.name } : null}
          initialStages={proposing.stages}
          onClose={() => setProposing(null)}
        />
      )}
    </>
  );
}
