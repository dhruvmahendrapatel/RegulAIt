/**
 * ADR-0173 batch 2b — the prompt Playground ("policy sandbox").
 *
 * Write a template with `{{variables}}` (the inputs pane is built from the
 * variables it finds), pick a model you hold with the governed picker
 * (feature "playground", so a model the org's policy forbids here shows as
 * not allowed), add an optional output schema and tool descriptions, and run.
 * Ctrl/⌘+Enter runs.
 *
 * NOTHING HERE IS A SHORTCUT: every run is one governed call made as you —
 * your grants, the project budget, guardrails and PII handling all apply, and
 * a refusal is shown in the gateway's own words. Tools are described to the
 * model; a tool call it makes is shown and NOT executed. Evaluate mode runs
 * the template over up to 50 rows, one governed call per row, and shows the
 * total cost. "Save as commit" writes the current editor state to the
 * prompt registry.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { ModelPicker } from "../../ui/ModelPicker";
import { Badge, Button, Field, Input, Modal, Select, Textarea } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { useMyModelTiles, useMyProjects } from "./builderApi";
import { Icon, Segmented } from "./BuilderUi";
import {
  pk,
  promptsApi,
  type CommitBody,
  type EvaluateResult,
  type PlaygroundRunResult,
  type PromptSummary,
  type PlaygroundToolCall,
  type PromptCommit,
  type PromptTool,
} from "./promptsApi";
import {
  extractVariables,
  fmtCost,
  isRunShortcut,
  MAX_EVAL_ROWS,
  parseJsonObject,
  prettyJson,
  rowsForRequest,
  shortHash,
  syncRows,
  syncValues,
  TOOL_NAME_RE,
  type EditableRow,
} from "./promptsLogic";
import s from "./builder.module.css";
import p from "./prompts.module.css";

const STARTER = "Summarise the following for {{audience}} in three bullet points.\n\n{{document}}";
const TOOLS_NOT_EXECUTED = "Tools are described to the model. If it calls one, you see the call here; it is not run in the playground.";

interface ToolDraft {
  key: number;
  name: string;
  description: string;
  schemaText: string;
}

interface Refusal {
  message: string;
  code: string | null;
}
const refusalOf = (e: unknown): Refusal =>
  e instanceof ApiError ? { message: e.message, code: e.payload.error ?? null } : { message: e instanceof Error ? e.message : String(e), code: null };

let toolKey = 0;
const newTool = (): ToolDraft => ({ key: ++toolKey, name: "", description: "", schemaText: '{\n  "type": "object",\n  "properties": {}\n}' });
const emptyRow = (vars: string[]): EditableRow => ({ inputs: syncValues(vars, {}), reference: "" });

function ToolCallList({ calls }: { calls: PlaygroundToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div>
      <span className={s.small}>Tool calls the model made (not run)</span>
      <ul className={s.list} aria-label="Tool calls" style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
        {calls.map((c, i) => (
          <li key={c.id ?? i} className={s.listRow}>
            <span className={s.listRowMain}>
              <span className={s.listRowTitle}>{c.name}</span>
              <span className={`${s.listRowSub} ${p.hash}`}>{JSON.stringify(c.arguments ?? c.input ?? {})}</span>
            </span>
            <Badge tone="neutral">not executed</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunOutput({ result }: { result: PlaygroundRunResult }) {
  const v = result.schemaValidation;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }} data-testid="run-output">
      <div className={p.facts}>
        <span>{result.model ?? "model"}</span>
        <span>· {fmtCost(result.costUsd)}</span>
        {result.usage && (
          <span>
            · {result.usage.inputTokens ?? "?"} in / {result.usage.outputTokens ?? "?"} out tokens
          </span>
        )}
      </div>
      <pre className={p.output} aria-label="Model output">
        {result.outputText ?? "(no text)"}
      </pre>
      {v && (
        <div role="status">
          <Badge tone={v.valid ? "ok" : "danger"}>{v.valid ? "Matches the output schema" : "Does not match the output schema"}</Badge>{" "}
          <span className={s.small}>
            {result.structuredOutput === "native"
              ? "The provider was asked for this structure, and the result was checked."
              : "This provider can't be asked for a structure, so the result was checked after the call."}
          </span>
          {!v.valid && v.errors.length > 0 && (
            <ul className={s.small} style={{ margin: "4px 0 0", paddingLeft: 18 }} aria-label="Schema errors">
              {v.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ToolCallList calls={result.toolCalls} />
    </div>
  );
}

function EvaluateOutput({ result }: { result: EvaluateResult }) {
  const sum = result.summary;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }} data-testid="evaluate-output">
      <p className={s.note} style={{ margin: 0 }} role="status">
        {sum.succeeded} of {sum.rows} rows ran{sum.failed ? `, ${sum.failed} refused or failed` : ""}. Total cost {fmtCost(sum.totalCostUsd)}
        {sum.unpricedCalls ? ` (${sum.unpricedCalls} call${sum.unpricedCalls === 1 ? "" : "s"} not priced)` : ""}.
        {result.structuredOutput ? ` ${sum.schemaPassed} matched the output schema.` : ""}
        {sum.withReference ? ` ${sum.referenceMatched} of ${sum.withReference} matched their reference.` : ""}
      </p>
      <div className={p.rowsScroll}>
        <table className={p.rowsTable} aria-label="Evaluation results">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Output</th>
              {result.structuredOutput && <th scope="col">Schema</th>}
              {sum.withReference > 0 && <th scope="col">Reference</th>}
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((r) => (
              <tr key={r.index}>
                <td>{r.index + 1}</td>
                <td>
                  {r.ok ? (
                    <span className={p.hash}>{(r.outputText ?? "").slice(0, 240) || "(no text)"}</span>
                  ) : (
                    <span className={p.err}>{r.detail ?? r.error}</span>
                  )}
                  {(r.toolCalls?.length ?? 0) > 0 && <div className={s.small}>{r.toolCalls!.length} tool call(s), not executed</div>}
                </td>
                {result.structuredOutput && (
                  <td>{r.schemaValidation ? <Badge tone={r.schemaValidation.valid ? "ok" : "danger"}>{r.schemaValidation.valid ? "pass" : "fail"}</Badge> : "—"}</td>
                )}
                {sum.withReference > 0 && <td>{r.referenceMatch ?? "—"}</td>}
                <td>{r.ok ? fmtCost(r.costUsd) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SaveCommitDialog(props: {
  open: boolean;
  onClose: () => void;
  loaded: { promptId: string; commitHash: string | null } | null;
  build: () => { content: Omit<CommitBody, "parentHash" | "message"> } | { error: string };
  onSaved: (promptId: string, commit: PromptCommit) => void;
}) {
  const prompts = useQuery({ queryKey: pk.prompts, queryFn: promptsApi.list, enabled: props.open });
  const editable = (prompts.data?.prompts ?? []).filter((r) => r.canEdit);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) {
      setTarget(props.loaded?.promptId ?? "");
      setMessage("");
      setError(null);
    }
  }, [props.open, props.loaded?.promptId]);
  const chosen = editable.find((r) => r.id === target) ?? null;
  // a commit records what it was edited from: the loaded commit when saving
  // back to the prompt it came from, otherwise that prompt's latest commit
  const parentHash = chosen ? (props.loaded?.promptId === chosen.id && props.loaded.commitHash ? props.loaded.commitHash : chosen.latestCommitHash) : null;
  const save = useMutation({
    mutationFn: async () => {
      const built = props.build();
      if ("error" in built) throw new Error(built.error);
      return promptsApi.commit(target, { ...built.content, parentHash, message: message.trim() });
    },
    onSuccess: (commit) => props.onSaved(target, commit),
    onError: (e) => setError(refusalOf(e).message),
  });
  return (
    <Modal
      open={props.open}
      title="Save as commit"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen || !message.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save commit"}
          </Button>
        </>
      }
    >
      {prompts.isSuccess && editable.length === 0 ? (
        <p className={s.note} style={{ margin: 0 }}>
          You have no prompt you can commit to. <Link to="/builder/prompts">Create a prompt</Link> first.
        </p>
      ) : (
        <Field label="Prompt">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a prompt</option>
            {editable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="What changed">
        <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="e.g. Ask for three bullet points" />
      </Field>
      {chosen && (
        <p className={s.small} style={{ margin: 0 }} data-testid="commit-parent">
          {parentHash ? (
            <>
              Edited from <span className={p.hash}>{shortHash(parentHash)}</span>.
            </>
          ) : (
            "This will be the prompt's first commit."
          )}{" "}
          Saving doesn&apos;t move any tag.
        </p>
      )}
      {error && (
        <p role="alert" className={p.err}>
          {error}
        </p>
      )}
    </Modal>
  );
}

export default function BuilderPlaygroundPage() {
  const [params, setParams] = useSearchParams();
  const promptParam = params.get("prompt");
  const commitParam = params.get("commit");
  const { auth } = useSession();
  const isAdmin = !!auth?.isAdmin;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const models = useMyModelTiles(auth?.userId ?? null);
  const projects = useMyProjects();
  const source = useQuery({ queryKey: pk.prompt(promptParam ?? ""), queryFn: () => promptsApi.get(promptParam!), enabled: !!promptParam });
  const datasets = useQuery({ queryKey: pk.datasets, queryFn: promptsApi.datasets, enabled: isAdmin });

  const [template, setTemplate] = useState(STARTER);
  const [values, setValues] = useState<Record<string, string>>({});
  const [modelAgentId, setModelAgentId] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [schemaText, setSchemaText] = useState("");
  const [tools, setTools] = useState<ToolDraft[]>([]);
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<"run" | "evaluate">("run");
  const [rows, setRows] = useState<EditableRow[]>(() => [emptyRow(extractVariables(STARTER))]);
  const [datasetId, setDatasetId] = useState("");
  const [result, setResult] = useState<PlaygroundRunResult | null>(null);
  const [evalResult, setEvalResult] = useState<EvaluateResult | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState<{ promptId: string; commitHash: string | null; name: string } | null>(null);
  const loadedKey = useRef<string | null>(null);

  const variables = useMemo(() => extractVariables(template), [template]);
  // the inputs pane and the evaluate rows follow the template's variables
  useEffect(() => {
    setValues((v) => syncValues(variables, v));
    setRows((r) => syncRows(r, variables));
  }, [variables]);
  // the default model once the person's models arrive
  useEffect(() => {
    if (!modelAgentId && models.defaultAgentId) setModelAgentId(models.defaultAgentId);
  }, [modelAgentId, models.defaultAgentId]);

  // open a prompt's commit (?prompt=…&commit=…; no commit = its latest)
  useEffect(() => {
    const d = source.data;
    if (!d) return;
    const commit = d.commits.find((c) => c.hash === commitParam) ?? d.commits[0] ?? null;
    const key = `${d.prompt.id}:${commit?.hash ?? "none"}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setLoaded({ promptId: d.prompt.id, commitHash: commit?.hash ?? null, name: d.prompt.name });
    if (!commit) return;
    setTemplate(commit.template);
    if (commit.modelConfig.agentId) setModelAgentId(commit.modelConfig.agentId);
    setMaxTokens(commit.modelConfig.maxTokens ? String(commit.modelConfig.maxTokens) : "");
    setSchemaText(prettyJson(commit.outputSchema));
    setTools(commit.tools.map((t) => ({ key: ++toolKey, name: t.name, description: t.description, schemaText: prettyJson(t.inputSchema) })));
    setResult(null);
    setEvalResult(null);
  }, [source.data, commitParam]);

  const schema = parseJsonObject(schemaText);
  const toolProblems = tools.map((t) => {
    if (!TOOL_NAME_RE.test(t.name)) return "Use letters, digits, - or _ (at most 64).";
    const parsed = parseJsonObject(t.schemaText);
    if (!parsed.ok) return parsed.error;
    return null;
  });
  const maxTokensNum = maxTokens.trim() ? Number(maxTokens) : null;
  const maxTokensBad = maxTokensNum !== null && (!Number.isInteger(maxTokensNum) || maxTokensNum < 1 || maxTokensNum > 32000);

  /** the editor's content as the gateway takes it, or the first problem */
  const build = useCallback(():
    | { content: { template: string; modelConfig: { agentId: string | null; maxTokens: number | null }; outputSchema: Record<string, unknown> | null; tools: PromptTool[] } }
    | { error: string } => {
    if (!template.trim()) return { error: "Write a template first." };
    if (!schema.ok) return { error: `Output schema: ${schema.error}` };
    const bad = toolProblems.findIndex((x) => x !== null);
    if (bad >= 0) return { error: `Tool ${bad + 1}: ${toolProblems[bad]}` };
    if (maxTokensBad) return { error: "Max output tokens must be a whole number from 1 to 32000." };
    return {
      content: {
        template,
        modelConfig: { agentId: modelAgentId || null, maxTokens: maxTokensNum },
        outputSchema: schema.value,
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (parseJsonObject(t.schemaText) as { value: Record<string, unknown> | null }).value ?? { type: "object", properties: {} } })),
      },
    };
  }, [template, schema, toolProblems, maxTokensBad, maxTokensNum, modelAgentId, tools]);

  const run = useMutation({
    mutationFn: async () => {
      const b = build();
      if ("error" in b) throw new Error(b.error);
      return promptsApi.run({
        template: b.content.template,
        variables: values,
        modelAgentId,
        ...(b.content.modelConfig.maxTokens ? { maxTokens: b.content.modelConfig.maxTokens } : {}),
        outputSchema: b.content.outputSchema,
        tools: b.content.tools,
        projectId: projectId || null,
      });
    },
    onMutate: () => setRefusal(null),
    onSuccess: (r) => setResult(r),
    onError: (e) => {
      setResult(null);
      setRefusal(refusalOf(e));
    },
  });
  const evaluate = useMutation({
    mutationFn: async () => {
      const b = build();
      if ("error" in b) throw new Error(b.error);
      const common = {
        template: b.content.template,
        modelAgentId,
        ...(b.content.modelConfig.maxTokens ? { maxTokens: b.content.modelConfig.maxTokens } : {}),
        outputSchema: b.content.outputSchema,
        tools: b.content.tools,
        projectId: projectId || null,
      };
      return promptsApi.evaluate(datasetId ? { ...common, datasetId } : { ...common, rows: rowsForRequest(rows) });
    },
    onMutate: () => setRefusal(null),
    onSuccess: (r) => setEvalResult(r),
    onError: (e) => {
      setEvalResult(null);
      setRefusal(refusalOf(e));
    },
  });
  const busy = run.isPending || evaluate.isPending;
  const canGo = !!modelAgentId && !busy && (mode === "run" || datasetId !== "" || rows.length > 0);
  const go = () => {
    if (!canGo) return;
    if (mode === "run") run.mutate();
    else evaluate.mutate();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isRunShortcut(e)) {
      e.preventDefault();
      go();
    }
  };

  const setTool = (key: number, patch: Partial<ToolDraft>) => setTools((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  return (
    <div onKeyDown={onKeyDown}>
      <PageHeader
        title="Playground"
        crumbs={["Agent builder"]}
        sub="Try a prompt on a model you can use. Every run is a governed call made as you."
        info={
          <p>
            Each run goes through the same checks as any other call you make: your access to the model, your organization&apos;s model policy for the
            playground, the project budget, guardrails and PII handling. Tools are described to the model, but a tool call it makes is only shown,
            never run. Evaluate mode runs the template over up to {MAX_EVAL_ROWS} rows, one governed call per row.
          </p>
        }
        actions={
          <div className={s.toolbar} style={{ margin: 0 }}>
            {loaded && (
              <Link to={`/builder/prompts/${loaded.promptId}`} className={s.helpLink}>
                {loaded.name}
                {loaded.commitHash ? ` @ ${shortHash(loaded.commitHash).slice(0, 7)}` : ""}
              </Link>
            )}
            <Button onClick={() => setSaving(true)}>Save as commit</Button>
          </div>
        }
      />
      <div className={p.pgGrid}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: 0 }}>
          <section className={p.pane} aria-labelledby="pg-prompt">
            <h2 className={p.paneTitle} id="pg-prompt">
              Prompt
            </h2>
            <Field label="Template">
              <Textarea className={p.template} value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} maxLength={50000} />
            </Field>
            <div className={p.row}>
              <span className={s.small}>Variables — write them as {"{{name}}"}:</span>
              {variables.length ? (
                <ul className={p.chips} aria-label="Detected variables">
                  {variables.map((v) => (
                    <li key={v} className={p.chip}>
                      {v}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={s.small}>none yet</span>
              )}
            </div>
            <ModelPicker label="Model" agents={models.tiles} value={modelAgentId} onChange={setModelAgentId} feature="playground" testId="playground-model" />
            <div className={p.row}>
              <Field label="Max output tokens (optional)" error={maxTokensBad ? "A whole number from 1 to 32000" : null}>
                <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" placeholder="model default" />
              </Field>
              <Field label="Bill to project (optional)">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">No project</option>
                  {(projects.data?.projects ?? []).map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </section>
          <section className={p.pane} aria-labelledby="pg-schema">
            <h2 className={p.paneTitle} id="pg-schema">
              Output schema
            </h2>
            <p className={s.small} style={{ margin: 0 }}>
              Optional JSON Schema. Where the provider supports it, the model is asked for this structure; either way the output is checked against it.
            </p>
            <Field label="JSON Schema" error={schema.ok ? null : schema.error}>
              <Textarea className={p.jsonEditor} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} spellCheck={false} placeholder='{"type": "object", "properties": {"summary": {"type": "string"}}}' />
            </Field>
          </section>
          <section className={p.pane} aria-labelledby="pg-tools">
            <h2 className={p.paneTitle} id="pg-tools">
              Tools
            </h2>
            <p className={s.note} style={{ margin: 0 }} data-testid="tools-not-executed">
              {TOOLS_NOT_EXECUTED}
            </p>
            {tools.map((t, i) => (
              <div key={t.key} className={p.toolCard} role="group" aria-label={`Tool ${i + 1}`}>
                <div className={p.row}>
                  <Field label="Name" error={t.name && toolProblems[i] && !TOOL_NAME_RE.test(t.name) ? toolProblems[i] : null}>
                    <Input value={t.name} onChange={(e) => setTool(t.key, { name: e.target.value })} placeholder="search_policies" maxLength={64} />
                  </Field>
                  <span className={p.grow} />
                  <Button size="sm" variant="ghost" aria-label={`Remove tool ${t.name || i + 1}`} onClick={() => setTools((ts) => ts.filter((x) => x.key !== t.key))}>
                    {Icon.trash()} Remove
                  </Button>
                </div>
                <Field label="Description">
                  <Input value={t.description} onChange={(e) => setTool(t.key, { description: e.target.value })} maxLength={1000} />
                </Field>
                <Field label="Input schema" error={(() => { const r = parseJsonObject(t.schemaText); return r.ok ? null : r.error; })()}>
                  <Textarea className={p.jsonEditor} value={t.schemaText} onChange={(e) => setTool(t.key, { schemaText: e.target.value })} spellCheck={false} />
                </Field>
              </div>
            ))}
            <button type="button" className={s.addRow} onClick={() => setTools((ts) => [...ts, newTool()])} disabled={tools.length >= 32}>
              {Icon.plus(14)} Add a tool
            </button>
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: 0 }}>
          <section className={p.pane} aria-labelledby="pg-run">
            <div className={p.row}>
              <h2 className={p.paneTitle} id="pg-run">
                {mode === "run" ? "Inputs" : "Rows"}
              </h2>
              <span className={p.grow} />
              <Segmented
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "run", label: "Single run" },
                  { value: "evaluate", label: "Evaluate" },
                ]}
              />
            </div>
            {mode === "run" ? (
              variables.length === 0 ? (
                <p className={s.small} style={{ margin: 0 }}>
                  This template has no variables, so it runs as written.
                </p>
              ) : (
                variables.map((v) => (
                  <Field key={v} label={v}>
                    <Textarea rows={2} value={values[v] ?? ""} onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))} />
                  </Field>
                ))
              )
            ) : (
              <>
                {isAdmin && (
                  <Field label="Rows from">
                    <Select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                      <option value="">Rows typed here</option>
                      {(datasets.data?.datasets ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          Evaluation dataset: {d.name} (v{d.version})
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {datasetId ? (
                  <p className={s.small} style={{ margin: 0 }}>
                    Each case of the dataset&apos;s current version is one row (at most {MAX_EVAL_ROWS}); its expected output is the reference.
                  </p>
                ) : (
                  <>
                    <div className={p.rowsScroll}>
                      <table className={p.rowsTable} aria-label="Evaluation rows">
                        <thead>
                          <tr>
                            <th scope="col">#</th>
                            {variables.map((v) => (
                              <th key={v} scope="col">
                                {v}
                              </th>
                            ))}
                            <th scope="col">Reference (optional)</th>
                            <th scope="col">
                              <span className={s.srOnly}>Remove</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              {variables.map((v) => (
                                <td key={v}>
                                  <Input
                                    aria-label={`Row ${i + 1} ${v}`}
                                    value={r.inputs[v] ?? ""}
                                    onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, inputs: { ...x.inputs, [v]: e.target.value } } : x)))}
                                  />
                                </td>
                              ))}
                              <td>
                                <Input
                                  aria-label={`Row ${i + 1} reference`}
                                  value={r.reference}
                                  onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))}
                                />
                              </td>
                              <td>
                                <button type="button" className={s.iconBtn} aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                                  {Icon.close(14)}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button type="button" className={s.addRow} onClick={() => setRows((rs) => [...rs, emptyRow(variables)])} disabled={rows.length >= MAX_EVAL_ROWS}>
                      {Icon.plus(14)} Add a row {rows.length >= MAX_EVAL_ROWS ? `(at most ${MAX_EVAL_ROWS})` : ""}
                    </button>
                  </>
                )}
              </>
            )}
            <div className={p.row}>
              <Button variant="primary" onClick={go} disabled={!canGo}>
                {busy ? "Running…" : mode === "run" ? "Run" : `Run ${datasetId ? "the dataset" : `${rows.length} row${rows.length === 1 ? "" : "s"}`}`}
              </Button>
              <span className={s.small}>
                or <kbd className={p.kbd}>Ctrl</kbd>/<kbd className={p.kbd}>⌘</kbd> + <kbd className={p.kbd}>Enter</kbd>
              </span>
              {!modelAgentId && <span className={s.small}>Choose a model first.</span>}
            </div>
          </section>
          <section className={p.pane} aria-labelledby="pg-output" aria-live="polite">
            <h2 className={p.paneTitle} id="pg-output">
              Output
            </h2>
            {refusal ? (
              <div role="alert" className={s.note} style={{ margin: 0 }} data-testid="playground-refusal">
                <span>
                  <strong>Not run.</strong> {refusal.message}
                  {refusal.code ? (
                    <>
                      {" "}
                      <code>{refusal.code}</code>
                    </>
                  ) : null}
                </span>
              </div>
            ) : mode === "run" && result ? (
              <RunOutput result={result} />
            ) : mode === "evaluate" && evalResult ? (
              <EvaluateOutput result={evalResult} />
            ) : (
              <p className={s.small} style={{ margin: 0 }}>
                Nothing run yet.
              </p>
            )}
          </section>
        </div>
      </div>
      <SaveCommitDialog
        open={saving}
        onClose={() => setSaving(false)}
        loaded={loaded}
        build={build}
        onSaved={(promptId, commit) => {
          setSaving(false);
          void queryClient.invalidateQueries({ queryKey: pk.prompts });
          void queryClient.invalidateQueries({ queryKey: pk.prompt(promptId) });
          loadedKey.current = `${promptId}:${commit.hash}`;
          setParams({ prompt: promptId, commit: commit.hash }, { replace: true });
          const name = queryClient.getQueryData<{ prompts: PromptSummary[] }>(pk.prompts)?.prompts.find((r) => r.id === promptId)?.name ?? "Prompt";
          setLoaded({ promptId, commitHash: commit.hash, name });
          toast(`Saved commit ${shortHash(commit.hash)}`, "success");
        }}
      />
    </div>
  );
}
