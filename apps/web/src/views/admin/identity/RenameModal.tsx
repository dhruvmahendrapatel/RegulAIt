/**
 * G10 (prototype): rename a role or a team.
 *
 * A plain rename saves with no confirmation. Two refusals are shown in place:
 * the name is taken (a field error), or the old name is matched BY NAME in
 * access policies / routing rules — renaming changes which requests those
 * apply to, so the dialog names them, asks for a reason, and the save becomes
 * a danger "Rename anyway" behind a step-up.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../../api/client";
import { plural } from "../../../api/format";
import { withStepUp } from "../../../stepup/stepUp";
import { Button, Field, Input, Modal } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { useAdminInvalidate } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Ref {
  id: string;
  name: string;
}
interface Referenced {
  policies: Ref[];
  rules: Ref[];
}

export function RenameModal(props: {
  /** "role" | "team" — used in every sentence and the route */
  noun: "role" | "team";
  target: { id: string; name: string; description?: string | null } | null;
  onClose: () => void;
}) {
  const { noun, target } = props;
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [referenced, setReferenced] = useState<Referenced | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(target?.name ?? "");
    setDescription(target?.description ?? "");
    setNameError(null);
    setError(null);
    setReferenced(null);
    setReason("");
    setReasonError(null);
  }, [target]);

  const path = `/v1/${noun}s/${target?.id}`;
  const body = () => ({ name: name.trim(), ...(noun === "role" ? { description: description.trim() || null } : {}) });
  const done = () => {
    toast(`${noun === "role" ? "Role" : "Team"} renamed`, "success");
    invalidate();
    props.onClose();
  };
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409 && e.payload.error === "name_taken") {
      setNameError(`A ${noun} called “${name.trim()}” already exists.`);
    } else if (e instanceof ApiError && e.status === 409 && e.payload.error === `${noun}_name_referenced`) {
      setReferenced({
        policies: (e.payload.policies as Ref[] | undefined) ?? [],
        rules: (e.payload.rules as Ref[] | undefined) ?? [],
      });
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setNameError(null);
    setError(null);
    if (!name.trim()) {
      setNameError("A name is required.");
      return;
    }
    setBusy(true);
    try {
      await api.patch(path, body());
      done();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const renameAnyway = async () => {
    setError(null);
    if (reason.trim().length < 10) {
      setReasonError("Say a little more — at least 10 characters. It is recorded in the audit log.");
      return;
    }
    setReasonError(null);
    setBusy(true);
    try {
      await withStepUp((h) => api.patchWithHeaders(path, { ...body(), reason: reason.trim(), acknowledgeReferences: true }, h));
      done();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const counts = referenced
    ? [
        referenced.policies.length ? plural(referenced.policies.length, "access policy", "access policies") : null,
        referenced.rules.length ? plural(referenced.rules.length, "routing rule") : null,
      ]
        .filter(Boolean)
        .join(" and ")
    : "";

  return (
    <Modal
      open={target !== null}
      title={`Rename ${noun} “${target?.name ?? ""}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          {referenced ? (
            <Button variant="danger" disabled={busy} onClick={() => void renameAnyway()}>
              Rename anyway
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          )}
        </>
      }
    >
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void (referenced ? renameAnyway() : save());
        }}
      >
        <Field label="Name" error={nameError}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
              // a different new name may not be referenced: ask again rather than carry the warning over
              setReferenced(null);
            }}
          />
        </Field>
        {noun === "role" && (
          <Field label="Description (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        )}
        {referenced && (
          <div
            className={a.outcome}
            style={{ borderColor: "var(--warn)", background: "var(--warn-soft)", color: "var(--warn-soft-text)" }}
            role="alert"
            data-testid="rename-referenced"
          >
            <strong>
              This name is used by {counts}, which match on the name, not the {noun}. Renaming changes which
              requests they apply to until they are updated. Past approvals and audit entries keep the old name.
            </strong>
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {referenced.policies.map((p) => (
                <li key={p.id}>
                  Access policy: {p.name} <span className={v.mono}>{p.id}</span>
                </li>
              ))}
              {referenced.rules.map((r) => (
                <li key={r.id}>
                  Routing rule: {r.name} <span className={v.mono}>{r.id}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {referenced && (
          <Field label="Reason (required, audited)" error={reasonError}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why rename now, and who updates the rules" />
          </Field>
        )}
        {referenced && <div className={v.faint}>You will be asked to confirm it's you.</div>}
        {error && (
          <div className={v.errLine} role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
