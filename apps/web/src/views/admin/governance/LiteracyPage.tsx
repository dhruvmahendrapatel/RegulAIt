/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI literacy. OWNER: A14 (D4).
 *
 * The admin's view of the AI policies and trainings people are asked to acknowledge: every version of each
 * document (draft, published, retired), who it applies to, coverage over that audience (with an admin-recorded
 * completion from an external training system), and the two settings this slice owns (`literacy_gate_mode`,
 * `literacy_default_validity_days`), each shown with its strict default and what relaxing it gives up.
 *
 * Copy follows Article 4 as amended by Regulation (EU) 2026/1744: the organisation takes measures to support the
 * development of AI literacy; nothing here measures or guarantees anyone's level of literacy.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Meter, Modal, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, ReasonModal, useAction, useRoles, useTeams } from "../adminKit";
import { KIND_TEXT, STATE_TEXT, policyHref, type LiteracyState } from "../../account/AcknowledgeGate";
import v from "../../views.module.css";
import { putOrgSettings } from "../../../stepup/stepUp";

interface AiPolicyDoc {
  id: string;
  key: string;
  kind: "acceptable_use" | "training";
  version: number;
  title: string;
  url: string | null;
  attachmentId: string | null;
  contentDigest: string;
  audience: { all: boolean; teamIds: string[]; roleIds: string[] };
  validityDays: number | null;
  status: "draft" | "published" | "retired";
  editorial: boolean;
  editorialReason: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

interface CoveragePerson {
  userId: string;
  displayName: string;
  email: string;
  state: LiteracyState;
  method: string | null;
  acknowledgedVersion: number | null;
  acknowledgedAt: string | null;
  expiresAt: string | null;
  expiresSoon: boolean;
  evidenceRef: string | null;
}
interface CoverageDoc {
  documentId: string;
  key: string;
  kind: string;
  version: number;
  title: string;
  editorial: boolean;
  publishedAt: string | null;
  audience: number;
  current: number;
  coveragePct: number;
  people: CoveragePerson[];
}

/** Mirrors `ACCOUNTABILITY_STRICT_DEFAULTS` / `ACCOUNTABILITY_SETTING_COPY` in @regulait/shared for the two A14
 * settings (the SPA does not depend on the shared package; it mirrors it, as dataSensitivity.ts does). */
export const LITERACY_SETTING_STRICT = { literacyGateMode: "enforce", literacyDefaultValidityDays: 365 } as const;
export const LITERACY_SETTING_COPY = {
  literacyGateMode: {
    label: "AI literacy gate",
    // one line per string: packages/shared/src/ai-literacy.test.ts checks each against the shared copy
    strict: "Enforce: a person to whom a published AI policy or training applies, and who has not acknowledged its current version, cannot make governed calls. With no applicable published document nothing changes.",
    relaxed: "Warn records the gap and allows the call; off skips the check.",
  },
  literacyDefaultValidityDays: {
    label: "Acknowledgement validity (days)",
    strict: "365 days: an acknowledgement expires after a year unless the document sets its own validity.",
    relaxed: "A longer validity (up to 730 days) asks people to re-acknowledge less often.",
  },
} as const;

const DOCS_KEY = ["admin", "ai-policies"] as const;
const COVERAGE_KEY = ["admin", "ai-policies", "coverage"] as const;
const SETTINGS_KEY = ["admin", "org-settings", "literacy"] as const;

function asDocs(x: unknown): AiPolicyDoc[] {
  const d = x as { documents?: unknown } | null;
  if (!d || !Array.isArray(d.documents)) throw new Error("The AI policies came back in an unexpected form. Retry, or check the gateway version.");
  return d.documents as AiPolicyDoc[];
}
function asCoverage(x: unknown): CoverageDoc[] {
  const d = x as { documents?: unknown } | null;
  if (!d || !Array.isArray(d.documents)) throw new Error("The coverage report came back in an unexpected form. Retry, or check the gateway version.");
  return d.documents as CoverageDoc[];
}

export default function LiteracyPage() {
  return (
    <>
      <PageHeader
        title="AI literacy"
        sub="AI policies and trainings, their versions, and who has acknowledged them."
        info={
          <p>
            Regulation (EU) 2024/1689, Article 4, as replaced by Regulation (EU) 2026/1744, asks providers and
            deployers to take measures to support the development of AI literacy of the people who operate and use AI
            systems on their behalf. It does not require any specific level of literacy of any individual. Publishing
            a policy or training here, and asking people to acknowledge its current version, is one such measure;
            regulAIt records the acknowledgements and does not measure literacy. With the gate set to enforce, a
            person to whom a published document applies cannot make governed AI calls until they acknowledge it.
            Agents and automations they run or own inherit their status.
          </p>
        }
      />
      <div className={v.stack}>
        <DocumentsCard />
        <CoverageCard />
        <LiteracySettingsCard />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Documents and versions
// ---------------------------------------------------------------------------

function DocumentsCard() {
  const act = useAction();
  const q = useQuery({ queryKey: DOCS_KEY, queryFn: async () => asDocs(await api.get<unknown>("/v1/ai-policies")) });
  const teams = useTeams();
  const roles = useRoles();
  const [creating, setCreating] = useState<null | { key?: string; kind?: AiPolicyDoc["kind"] }>(null);
  const [publishing, setPublishing] = useState<AiPolicyDoc | null>(null);
  const [retiring, setRetiring] = useState<AiPolicyDoc | null>(null);
  const docs = q.data ?? [];
  const teamName = useMemo(() => new Map((teams.data?.teams ?? []).map((t) => [t.id, t.name])), [teams.data]);
  const roleName = useMemo(() => new Map((roles.data?.roles ?? []).map((r) => [r.id, r.name])), [roles.data]);
  const hasPublished = (key: string) => docs.some((d) => d.key === key && d.status === "published");

  const audienceText = (a: AiPolicyDoc["audience"]) =>
    a.all
      ? "everyone"
      : [
          ...a.teamIds.map((id) => `team ${teamName.get(id) ?? id.slice(0, 8)}`),
          ...a.roleIds.map((id) => `role ${roleName.get(id) ?? id.slice(0, 8)}`),
        ].join(", ");

  return (
    <Card
      title="Documents and versions"
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating({})}>
          New document
        </Button>
      }
    >
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <Table<AiPolicyDoc>
          rows={docs}
          rowKey={(d) => d.id}
          empty={
            <EmptyState
              title="No AI policies yet"
              body="Nothing is asked of anyone until a document is published. Create a draft, then publish it."
            />
          }
          columns={[
            {
              key: "doc",
              header: "Document",
              render: (d) => (
                <div>
                  <div className={v.rowTight}>
                    <strong>{d.title}</strong>
                    <Badge>{KIND_TEXT[d.kind] ?? d.kind}</Badge>
                  </div>
                  <div className={v.faint}>
                    <span className={v.mono}>{d.key}</span> · version {d.version}
                    {policyHref(d.url) ? (
                      <>
                        {" · "}
                        <a href={policyHref(d.url)!} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                          open
                        </a>
                      </>
                    ) : d.url ? (
                      <span data-testid="policy-link-unsafe"> · link not shown (not an https address)</span>
                    ) : null}
                  </div>
                </div>
              ),
              sort: (d) => `${d.key}:${String(d.version).padStart(6, "0")}`,
            },
            {
              key: "status",
              header: "Status",
              render: (d) => (
                <span className={v.rowTight}>
                  <Badge tone={d.status === "published" ? "ok" : d.status === "draft" ? "info" : "neutral"}>{d.status}</Badge>
                  {d.editorial && (
                    <Badge tone="warn" title={d.editorialReason ?? undefined}>
                      editorial
                    </Badge>
                  )}
                </span>
              ),
            },
            { key: "audience", header: "Applies to", render: (d) => audienceText(d.audience) },
            {
              key: "validity",
              header: "Valid for",
              render: (d) => (d.validityDays ? `${d.validityDays} days` : "org default"),
            },
            {
              key: "when",
              header: "Published",
              render: (d) => (d.publishedAt ? fmtAt(d.publishedAt) : "—"),
            },
            {
              key: "actions",
              header: "",
              render: (d) => (
                <span className={v.rowTight}>
                  {d.status === "draft" && (
                    <Button size="sm" variant="primary" disabled={act.busy} onClick={() => setPublishing(d)}>
                      Publish
                    </Button>
                  )}
                  {d.status === "published" && (
                    <Button size="sm" disabled={act.busy} onClick={() => setCreating({ key: d.key, kind: d.kind })}>
                      New version
                    </Button>
                  )}
                  {d.status !== "retired" && (
                    <Button size="sm" variant="danger" disabled={act.busy} onClick={() => setRetiring(d)}>
                      Retire
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </QueryGate>

      {creating && (
        <CreateModal
          initial={creating}
          teams={teams.data?.teams ?? []}
          roles={roles.data?.roles ?? []}
          busy={act.busy}
          onCancel={() => setCreating(null)}
          onCreate={(body) =>
            void act
              .run(async () => {
                await api.post("/v1/ai-policies", body);
              }, "Draft created. Nothing is asked of anyone until it is published.")
              .then((ok) => ok && setCreating(null))
          }
        />
      )}

      {publishing && (
        <PublishModal
          doc={publishing}
          canBeEditorial={publishing.version > 1 && hasPublished(publishing.key)}
          busy={act.busy}
          onCancel={() => setPublishing(null)}
          onPublish={(body) =>
            void act
              .run(async () => {
                await api.post(`/v1/ai-policies/${publishing.id}/publish`, body);
              }, body.editorial ? "Published as an editorial version; existing acknowledgements still count. Audited." : "Published. Everyone it applies to is asked to acknowledge this version.")
              .then((ok) => ok && setPublishing(null))
          }
        />
      )}

      <ReasonModal
        open={retiring !== null}
        title={retiring ? `Retire “${retiring.title}” version ${retiring.version}?` : "Retire"}
        body={
          retiring?.status === "published"
            ? "It stops applying to anyone at once: nobody is asked to acknowledge it, and governed calls are no longer held for it. The versions and acknowledgements are kept."
            : "The draft is set aside and can no longer be published."
        }
        confirmLabel="Retire"
        danger
        minLength={10}
        placeholder="why is this version retiring? (required, at least 10 characters, audited)"
        onCancel={() => setRetiring(null)}
        onConfirm={(reason) => {
          const d = retiring!;
          setRetiring(null);
          void act.run(async () => {
            await api.post(`/v1/ai-policies/${d.id}/retire`, { reason });
          }, "Retired. Recorded in the audit trail.");
        }}
      />
    </Card>
  );
}

function CreateModal(props: {
  initial: { key?: string; kind?: AiPolicyDoc["kind"] };
  teams: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [key, setKey] = useState(props.initial.key ?? "");
  const [kind, setKind] = useState<AiPolicyDoc["kind"]>(props.initial.kind ?? "acceptable_use");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [validity, setValidity] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const newVersion = props.initial.key !== undefined;

  const submit = () => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) return setErr("The key is lower-case letters, digits and dashes.");
    if (!title.trim()) return setErr("Give the document a title.");
    if (!policyHref(url.trim())) return setErr("Link to the document with an https:// address.");
    if (!everyone && teamIds.length + roleIds.length === 0) return setErr("Choose at least one team or role, or apply it to everyone.");
    const days = validity.trim() ? Number(validity) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days < 30 || days > 730)) return setErr("Validity is 30 to 730 days, or leave it empty for the org default.");
    setErr(null);
    props.onCreate({
      key,
      kind,
      title: title.trim(),
      url: url.trim(),
      audience: { all: everyone, teamIds: everyone ? [] : teamIds, roleIds: everyone ? [] : roleIds },
      ...(days !== undefined ? { validityDays: days } : {}),
    });
  };

  const multi = (label: string, opts: Array<{ id: string; name: string }>, value: string[], set: (x: string[]) => void) => (
    <Field label={label}>
      <Select
        multiple
        value={value}
        onChange={(e) => set(Array.from(e.target.selectedOptions).map((o) => o.value))}
        style={{ minHeight: 88 }}
      >
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Modal
      open
      title={newVersion ? `New version of ${props.initial.key}` : "New AI policy or training"}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={submit}>
            Create draft
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {err && (
          <div className={v.errLine} role="alert">
            {err}
          </div>
        )}
        <Field label="Key (stays the same across versions)">
          <Input value={key} disabled={newVersion} onChange={(e) => setKey(e.target.value.trim().toLowerCase())} placeholder="acceptable-use" />
        </Field>
        <Field label="Kind">
          <Select value={kind} disabled={newVersion} onChange={(e) => setKind(e.target.value as AiPolicyDoc["kind"])}>
            <option value="acceptable_use">Acceptable-use policy</option>
            <option value="training">Training</option>
          </Select>
        </Field>
        <Field label="Title">
          <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Link to the document">
          <Input value={url} type="url" onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </Field>
        <div className={v.rowTight}>
          <input id="lit-everyone" type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
          <label htmlFor="lit-everyone">Applies to everyone (the strictest audience)</label>
        </div>
        {!everyone && (
          <div className={v.row}>
            {multi("Teams", props.teams, teamIds, setTeamIds)}
            {multi("Roles (including roles mapped from SCIM groups)", props.roles, roleIds, setRoleIds)}
          </div>
        )}
        <Field label="Valid for (days, empty = the org default)">
          <Input value={validity} inputMode="numeric" onChange={(e) => setValidity(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
    </Modal>
  );
}

function PublishModal(props: {
  doc: AiPolicyDoc;
  canBeEditorial: boolean;
  busy: boolean;
  onCancel: () => void;
  onPublish: (body: { editorial: boolean; editorialReason?: string }) => void;
}) {
  const [editorial, setEditorial] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    if (editorial && reason.trim().length < 10) return setErr("Say why this change does not need re-acknowledgement (at least 10 characters).");
    setErr(null);
    props.onPublish(editorial ? { editorial: true, editorialReason: reason.trim() } : { editorial: false });
  };
  return (
    <Modal
      open
      title={`Publish “${props.doc.title}” version ${props.doc.version}`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={go}>
            Publish
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {err && (
          <div className={v.errLine} role="alert">
            {err}
          </div>
        )}
        <p className={v.hint}>
          Publishing replaces the published version of <span className={v.mono}>{props.doc.key}</span>, if there is
          one. By default everyone it applies to must acknowledge this version before their next governed AI call
          (no grace period).
        </p>
        {props.canBeEditorial ? (
          <>
            <div className={v.rowTight}>
              <input id="lit-editorial" type="checkbox" checked={editorial} onChange={(e) => setEditorial(e.target.checked)} />
              <label htmlFor="lit-editorial">This is an editorial change: keep the existing acknowledgements</label>
            </div>
            {editorial && (
              <Field label="Why does this change not need re-acknowledgement? (audited)">
                <Textarea value={reason} rows={3} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
            {editorial && (
              <div className={v.faint}>
                A relaxation: people who acknowledged the previous version are not asked again. The change and your
                reason are recorded in the audit trail.
              </div>
            )}
          </>
        ) : (
          <div className={v.faint}>
            An editorial version needs a published version of the same key to replace, so this one is published as a
            material version.
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Coverage and recorded completions
// ---------------------------------------------------------------------------

function CoverageCard() {
  const act = useAction();
  const q = useQuery({ queryKey: COVERAGE_KEY, queryFn: async () => asCoverage(await api.get<unknown>("/v1/ai-policies/coverage")) });
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ doc: CoverageDoc; person: CoveragePerson } | null>(null);
  const docs = q.data ?? [];
  return (
    <Card title="Coverage">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {docs.length === 0 ? (
          <EmptyState title="Nothing published" body="Coverage appears once a document is published." />
        ) : (
          <div className={v.stack}>
            <p className={v.hint}>
              Who each published document applies to and who has acknowledged its current version (or an editorial
              equivalent) and is not expired. Reading this report is recorded in the audit trail. A document below
              100% raises a low, observe-only alert.
            </p>
            {docs.map((d) => (
              <div key={d.documentId} className={v.stack}>
                <div className={v.row}>
                  <strong>{d.title}</strong>
                  <span className={v.faint}>
                    {d.key} v{d.version}
                  </span>
                  <span className={v.grow} />
                  <span>
                    {d.current} of {d.audience} current ({d.coveragePct}%)
                  </span>
                  <Button size="sm" variant="ghost" aria-expanded={open === d.documentId} onClick={() => setOpen(open === d.documentId ? null : d.documentId)}>
                    {open === d.documentId ? "Hide people" : "Show people"}
                  </Button>
                </div>
                <Meter value={d.current} max={Math.max(1, d.audience)} warn={d.current < d.audience} label={`${d.title}: ${d.coveragePct}% current`} />
                {open === d.documentId && (
                  <Table<CoveragePerson>
                    rows={d.people}
                    rowKey={(p) => p.userId}
                    empty={<EmptyState title="Nobody in the audience" body="No active person matches this document's audience." />}
                    columns={[
                      { key: "who", header: "Person", render: (p) => `${p.displayName} · ${p.email}`, sort: (p) => p.displayName },
                      {
                        key: "state",
                        header: "State",
                        render: (p) => (
                          <span className={v.rowTight}>
                            <Badge tone={STATE_TEXT[p.state].tone}>{STATE_TEXT[p.state].label}</Badge>
                            {p.expiresSoon && <Badge tone="info">expires soon</Badge>}
                          </span>
                        ),
                        sort: (p) => p.state,
                      },
                      {
                        key: "how",
                        header: "How",
                        render: (p) =>
                          p.method ? (
                            <span>
                              {p.method.replace("_", " ")}
                              {p.acknowledgedVersion !== null && p.acknowledgedVersion !== d.version ? ` (v${p.acknowledgedVersion})` : ""}
                              {p.evidenceRef ? <span className={v.faint}> · {p.evidenceRef}</span> : null}
                            </span>
                          ) : (
                            "—"
                          ),
                      },
                      { key: "until", header: "Valid until", render: (p) => (p.expiresAt ? fmtAt(p.expiresAt) : "—") },
                      {
                        key: "record",
                        header: "",
                        render: (p) => (
                          <Button size="sm" disabled={act.busy} onClick={() => setRecording({ doc: d, person: p })}>
                            Record completion
                          </Button>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </QueryGate>
      {recording && (
        <RecordModal
          doc={recording.doc}
          person={recording.person}
          busy={act.busy}
          onCancel={() => setRecording(null)}
          onRecord={(body) =>
            void act
              .run(async () => {
                await api.post(`/v1/ai-policies/${recording.doc.documentId}/records`, { userId: recording.person.userId, ...body });
              }, "Completion recorded with its evidence reference. Audited.")
              .then((ok) => ok && setRecording(null))
          }
        />
      )}
    </Card>
  );
}

function RecordModal(props: {
  doc: CoverageDoc;
  person: CoveragePerson;
  busy: boolean;
  onCancel: () => void;
  onRecord: (body: { method: string; evidenceRef: string; completedAt?: string }) => void;
}) {
  const [method, setMethod] = useState("training_completed");
  const [evidence, setEvidence] = useState("");
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    if (!evidence.trim()) return setErr("An evidence reference is required (for example the training system's completion id).");
    setErr(null);
    props.onRecord({
      method,
      evidenceRef: evidence.trim(),
      ...(date ? { completedAt: new Date(`${date}T12:00:00Z`).toISOString() } : {}),
    });
  };
  return (
    <Modal
      open
      title={`Record a completion for ${props.person.displayName}`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={go}>
            Record
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        {err && (
          <div className={v.errLine} role="alert">
            {err}
          </div>
        )}
        <p className={v.hint}>
          Records that this person completed “{props.doc.title}” version {props.doc.version} outside regulAIt (for
          example in a training system). It counts like their own acknowledgement and expires after the document's
          validity. It never shortens an acknowledgement they already hold.
        </p>
        <Field label="Recorded as">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="training_completed">training completed</option>
            <option value="admin_recorded">recorded by an admin</option>
          </Select>
        </Field>
        <Field label="Evidence reference">
          <Input value={evidence} maxLength={1000} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <Field label="Completed on (empty = today)">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Settings (admin): the two settings this slice owns
// ---------------------------------------------------------------------------

interface LiteracySettings {
  literacyGateMode: "off" | "warn" | "enforce";
  literacyDefaultValidityDays: number;
}

function LiteracySettingsCard() {
  const act = useAction();
  const q = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => {
      const r = await api.get<{ settings?: Partial<LiteracySettings> }>("/v1/org/settings");
      const s = r.settings ?? {};
      if (typeof s.literacyGateMode !== "string" || typeof s.literacyDefaultValidityDays !== "number") {
        throw new Error("The organisation settings came back without the literacy settings. Check the gateway version.");
      }
      return s as LiteracySettings;
    },
  });
  const [mode, setMode] = useState<LiteracySettings["literacyGateMode"] | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const s = q.data;
  const nextMode = mode ?? s?.literacyGateMode ?? "enforce";
  const nextDays = days ?? String(s?.literacyDefaultValidityDays ?? LITERACY_SETTING_STRICT.literacyDefaultValidityDays);
  const daysNum = Number(nextDays);
  const daysOk = Number.isInteger(daysNum) && daysNum >= 30 && daysNum <= 730;
  const dirty = !!s && (nextMode !== s.literacyGateMode || daysNum !== s.literacyDefaultValidityDays);
  const relaxing = !!s && (nextMode !== "enforce" || daysNum > LITERACY_SETTING_STRICT.literacyDefaultValidityDays);
  const gateCopy = LITERACY_SETTING_COPY.literacyGateMode;
  const daysCopy = LITERACY_SETTING_COPY.literacyDefaultValidityDays;

  const save = () =>
    void act
      .run(async () => {
        await putOrgSettings({ literacyGateMode: nextMode, literacyDefaultValidityDays: daysNum });
        setMode(null);
        setDays(null);
        await q.refetch();
      }, "Literacy settings saved. The change is recorded in the audit trail with the old and new values.")
      .then(() => setConfirm(false));

  const badge = (relaxed: boolean) => (relaxed ? <Badge tone="warn">relaxed</Badge> : <Badge tone="ok">strict default</Badge>);

  return (
    <Card title="Settings (admin)">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {s && (
          <div className={v.stack}>
            <div className={v.stack}>
              <div className={v.rowTight}>
                <strong>{gateCopy.label}</strong>
                {badge(s.literacyGateMode !== "enforce")}
              </div>
              <div className={v.faint}>Strict default: {gateCopy.strict}</div>
              <div className={v.faint}>Relaxing: {gateCopy.relaxed}</div>
              <Field label="Gate mode">
                <Select value={nextMode} onChange={(e) => setMode(e.target.value as LiteracySettings["literacyGateMode"])}>
                  <option value="enforce">enforce (strict default)</option>
                  <option value="warn">warn (relaxed: record and allow)</option>
                  <option value="off">off (relaxed: skip the check)</option>
                </Select>
              </Field>
            </div>
            <div className={v.stack}>
              <div className={v.rowTight}>
                <strong>{daysCopy.label}</strong>
                {badge(s.literacyDefaultValidityDays > LITERACY_SETTING_STRICT.literacyDefaultValidityDays)}
              </div>
              <div className={v.faint}>Strict default: {daysCopy.strict}</div>
              <div className={v.faint}>Relaxing: {daysCopy.relaxed}</div>
              <Field label="Default validity (days, 30 to 730)" error={daysOk ? null : "30 to 730 days"}>
                <Input value={nextDays} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
              </Field>
            </div>
            <div>
              <Button variant="primary" disabled={act.busy || !dirty || !daysOk} onClick={() => (relaxing ? setConfirm(true) : save())}>
                Save literacy settings
              </Button>
            </div>
          </div>
        )}
      </QueryGate>
      <ConfirmModal
        open={confirm}
        title="Relax the AI literacy settings?"
        body="This is looser than the strict default. The change is recorded in the audit trail with the old and new values."
        confirmLabel="Save relaxed settings"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={save}
      />
    </Card>
  );
}
