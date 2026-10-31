/**
 * ADR-0207 (G4–G6) — the edit, token and rotation dialogs of the integration pages, in one module the pages load
 * lazily (React.lazy), so none of it is in a page's chunk until somebody opens a dialog.
 */
import { useState } from "react";
import { ApiError, api } from "../../../api/client";
import type { GitConnection, McpServer, PmConnection } from "../../../api/adminTypes";
import { fmtAt } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Button, Field, Input, Modal, Select } from "../../../ui/kit";
import { useAction, type RevealedSecret } from "../adminKit";
import { useToast } from "../../../ui/toast";
import v from "../../views.module.css";

const DRIFT = [
  { v: "manual", l: "Manual: record drift, change nothing (default)" },
  { v: "prefer_regulait", l: "Prefer regulAIt: put regulAIt's state back in the PM tool" },
  { v: "prefer_pm", l: "Prefer the PM tool: adopt its state on the link (the run itself never moves)" },
];

/** G4: rename an MCP server or move its url. A url move clears its identity propagation and upstream credential. */
export function EditServerDialog(props: { server: McpServer; onClose: () => void }) {
  const act = useAction();
  const s = props.server;
  const isStdio = s.transport === "stdio";
  const [name, setName] = useState(s.name);
  const [url, setUrl] = useState(s.url);
  const urlMoves = !isStdio && url.trim() !== s.url;
  const save = () =>
    void act
      .run(
        () =>
          withStepUp((h) =>
            stepUpApi.patch(
              `/v1/servers/${encodeURIComponent(s.id)}`,
              { ...(name.trim() !== s.name ? { name: name.trim() } : {}), ...(urlMoves ? { url: url.trim() } : {}) },
              h,
            ),
          ),
        `MCP server “${name.trim()}” updated`,
      )
      .then((ok) => ok && props.onClose());
  return (
    <Modal
      open
      title={`Edit MCP server “${s.name}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy || !name.trim() || (name.trim() === s.name && !urlMoves)} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!isStdio && (
          <Field label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </Field>
        )}
        {urlMoves && (
          <p className={`${v.errLine} ${v.flush}`} role="note">
            Moving the URL turns identity propagation off and deletes the stored upstream credential: neither follows the server to a new
            destination. The new URL is checked by the egress guard before it is saved.
          </p>
        )}
        <p className={`${v.faint} ${v.flush}`}>The change is recorded in the audit log.</p>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** G5 / G6: the token is replaced in place and never shown again; the route is named literally for each kind */
export function ReplaceTokenDialog(props: { kind: "git" | "pm"; connection: { name: string }; onClose: () => void }) {
  const act = useAction();
  const [token, setToken] = useState("");
  const c = props.connection;
  const host = props.kind === "git" ? "git host" : "PM tool";
  const save = () =>
    void act
      .run(
        () =>
          props.kind === "git"
            ? api.post(`/v1/git/connections/${encodeURIComponent(c.name)}/token`, { token })
            : api.post(`/v1/pm/connections/${encodeURIComponent(c.name)}/token`, { token }),
        `Token replaced. Revoke the old token in the ${host}.`,
      )
      .then((ok) => ok && props.onClose());
  return (
    <Modal
      open
      title={`Replace the token for “${c.name}”?`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy || !token} onClick={save}>
            Replace token
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.flush}>
          The stored token is overwritten and the old one is destroyed here.{" "}
          {props.kind === "git" ? "Git stages use the new token from their next step." : "Syncs use the new token from their next call."} The old
          token still works in the {host} until you revoke it there. The change is recorded in the audit log.
        </p>
        <Field label="New token">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="never shown again"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && token) save();
            }}
          />
        </Field>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function EditGitDialog(props: { connection: GitConnection; onClose: () => void }) {
  const act = useAction();
  const c = props.connection;
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const { toast } = useToast();
  const save = () => {
    setRefusal(null);
    let saved = false;
    void act
      .run(async () => {
        try {
          await api.patch(`/v1/git/connections/${encodeURIComponent(c.name)}`, { baseUrl: baseUrl || null });
          saved = true;
        } catch (e) {
          // the egress refusal is answered in the dialog, where the URL is
          if (e instanceof ApiError && e.status === 400 && e.payload?.error === "egress_blocked") {
            setRefusal("That host isn't on the egress allow-list.");
            return;
          }
          throw e;
        }
      }, null)
      .then(() => {
        if (!saved) return;
        toast(`Git connection “${c.name}” updated`, "success");
        props.onClose();
      });
  };
  return (
    <Modal
      open
      title={`Edit git connection “${c.name}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <Field label="Name">
          <Input value={c.name} readOnly aria-readonly />
        </Field>
        <Field label="Provider">
          <Input value={c.provider} readOnly aria-readonly />
        </Field>
        <p className={`${v.faint} ${v.flush}`}>
          The name can't change: workflow stages refer to it.
        </p>
        <Field label="Base URL (empty for the provider default)">
          <Input autoFocus value={baseUrl} onChange={(e) => (setBaseUrl(e.target.value), setRefusal(null))} placeholder="https://…" />
        </Field>
        {refusal ? (
          <div className={v.errLine} role="alert" data-testid="edit-refusal">
            {refusal}
          </div>
        ) : (
          act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}

interface RotateResult {
  webhookSecret: string;
  /** when the previous secret stops working; null for an immediate rotation */
  previousValidUntil: string | null;
}

export function RotateSecretDialog(props: { connection: PmConnection; onClose: () => void; onRotated: (r: RevealedSecret) => void }) {
  const act = useAction();
  const { toast } = useToast();
  const c = props.connection;
  const [inProgress, setInProgress] = useState(false);
  const rotate = (immediate: boolean) => {
    let out: RotateResult | null = null;
    void act
      .run(async () => {
        try {
          out = await api.post<RotateResult>(`/v1/pm/connections/${encodeURIComponent(c.name)}/webhook-secret/rotate`, immediate ? { immediate: true } : {});
        } catch (e) {
          // a second rotation inside the grace window is answered here, with the way out beside it
          if (e instanceof ApiError && e.status === 409 && e.payload?.error === "rotation_in_progress") {
            setInProgress(true);
            return;
          }
          throw e;
        }
      }, null)
      .then(() => {
        const r = out as RotateResult | null;
        if (!r) return;
        toast("New webhook secret issued. Copy it now: it is shown once.", "success");
        props.onRotated({
          title: "New webhook secret",
          secret: r.webhookSecret,
          note: r.previousValidUntil
            ? `The previous secret stops working on ${fmtAt(r.previousValidUntil)}.`
            : "The previous secret has stopped working.",
        });
      });
  };
  return (
    <Modal
      open
      title={`Rotate the webhook secret for “${c.name}”?`}
      onClose={props.onClose}
      actions={
        inProgress ? (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="danger" disabled={act.busy} onClick={() => rotate(true)}>
              Rotate immediately
            </Button>
          </>
        ) : (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" disabled={act.busy} onClick={() => rotate(false)}>
              Rotate secret
            </Button>
          </>
        )
      }
    >
      <div className={v.stack}>
        <p className={v.flush}>
          A new webhook secret is issued and shown once. The current secret keeps working for 24 hours, then events signed with it are refused.
          Register the new secret in the PM tool before then.
        </p>
        {inProgress && (
          <div className={v.stackTight} role="alert" data-testid="rotation-in-progress">
            <p className={`${v.errLine} ${v.flush}`}>
              A rotation is already in progress. Wait until the previous secret expires, or rotate immediately.
            </p>
            <p className={`${v.faint} ${v.flush}`}>
              Rotating immediately ends both older secrets now: events the PM tool signs with them are refused until it has the new one.
            </p>
          </div>
        )}
        {act.error && !inProgress && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function EditPmDialog(props: { connection: PmConnection; onClose: () => void }) {
  const act = useAction();
  const c = props.connection;
  const [f, setF] = useState({
    project: c.project,
    baseUrl: c.baseUrl ?? "",
    apiVersion: c.apiVersion ? String(c.apiVersion) : "",
    driftResolution: c.driftResolution ?? "manual",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const save = () =>
    void act
      .run(
        () =>
          api.patch(`/v1/pm/connections/${encodeURIComponent(c.name)}`, {
            project: f.project,
            baseUrl: f.baseUrl || null,
            ...(c.provider === "jira" ? { apiVersion: f.apiVersion ? Number(f.apiVersion) : null } : {}),
            driftResolution: f.driftResolution,
          }),
        `PM connection “${c.name}” updated`,
      )
      .then((ok) => ok && props.onClose());
  return (
    <Modal
      open
      title={`Edit PM connection “${c.name}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy || !f.project} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <Field label="Name">
          <Input value={c.name} readOnly aria-readonly />
        </Field>
        <p className={`${v.faint} ${v.flush}`}>
          The name is part of the webhook address and can't change.
        </p>
        <Field label="Project">
          <Input required autoFocus value={f.project} onChange={(e) => set("project", e.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://…" />
        </Field>
        {c.provider === "jira" && (
          <Field label="API version">
            <Select value={f.apiVersion} onChange={(e) => set("apiVersion", e.target.value)}>
              <option value="">v2 (default, plain text)</option>
              <option value="3">v3 + ADF rich text</option>
              <option value="2">v2 (legacy plain text)</option>
            </Select>
          </Field>
        )}
        <Field label="When the PM tool and regulAIt disagree">
          <Select value={f.driftResolution} onChange={(e) => set("driftResolution", e.target.value)}>
            {DRIFT.map((d) => (
              <option key={d.v} value={d.v}>
                {d.l}
              </option>
            ))}
          </Select>
        </Field>
        <p className={`${v.faint} ${v.flush}`}>
          A changed base URL is checked by the egress guard before it is saved. Every change is recorded in the audit log.
        </p>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}
