/**
 * An edit dialog over `patchForm.ts`: the fields of one record, opened with
 * its current values, sending only what was edited. The refusal is shown in
 * the dialog in the gateway's words and the dialog stays open, so nothing
 * typed is lost.
 */
import { useId, useState, type ReactNode } from "react";
import { Button, Field, Fieldset, Input, Modal, Select, Textarea } from "../../ui/kit";
import v from "../views.module.css";
import { draftFromRecord, patchBody, type PatchDraft, type PatchField } from "./patchForm";

export function PatchFormModal(props: {
  title: string;
  fields: readonly PatchField[];
  record: Record<string, unknown>;
  /** send the body; resolve when stored, throw the refusal otherwise */
  save: (body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  onSaved?: () => void;
  /** a sentence above the fields (e.g. what moving an endpoint does) */
  intro?: ReactNode;
  saveLabel?: string;
}) {
  const [draft, setDraft] = useState<PatchDraft>(() => draftFromRecord(props.fields, props.record));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = useId();
  const result = patchBody(props.fields, props.record, draft);
  const setText = (k: string, t: string) => setDraft((d) => ({ ...d, text: { ...d.text, [k]: t } }));
  const submit = async () => {
    if (!result.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.save(result.body);
      props.onSaved?.();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={props.title}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      actions={
        <>
          <Button disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !result.ok} onClick={() => void submit()}>
            {busy ? "Saving…" : (props.saveLabel ?? "Save changes")}
          </Button>
        </>
      }
    >
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {props.intro}
        {props.fields.map((f) => {
          const id = `${base}-${f.key}`;
          const helpId = f.help ? `${id}-help` : undefined;
          const help = f.help ? (
            <p className={v.faint} id={helpId}>
              {f.help}
            </p>
          ) : null;
          switch (f.kind) {
            case "text":
            case "list":
              return (
                <div key={f.key}>
                  <Field label={f.label}>
                    <Input
                      id={id}
                      value={draft.text[f.key] ?? ""}
                      maxLength={f.kind === "text" ? f.maxLength : undefined}
                      placeholder={f.kind === "text" ? f.placeholder : "comma-separated"}
                      aria-describedby={helpId}
                      onChange={(e) => setText(f.key, e.target.value)}
                    />
                  </Field>
                  {help}
                </div>
              );
            case "textarea":
              return (
                <div key={f.key}>
                  <Field label={f.label}>
                    <Textarea id={id} rows={4} value={draft.text[f.key] ?? ""} maxLength={f.maxLength} aria-describedby={helpId} onChange={(e) => setText(f.key, e.target.value)} />
                  </Field>
                  {help}
                </div>
              );
            case "select":
              return (
                <div key={f.key}>
                  <Field label={f.label}>
                    <Select id={id} value={draft.text[f.key] ?? ""} aria-describedby={helpId} onChange={(e) => setText(f.key, e.target.value)}>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {help}
                </div>
              );
            case "multi":
              return (
                <div key={f.key}>
                  <Fieldset legend={f.label}>
                    {f.loading ? (
                      <p className={v.faint} role="status">Loading the choices…</p>
                    ) : f.options.length === 0 ? (
                      <p className={v.faint}>Nothing to choose from.</p>
                    ) : null}
                    {f.options.map((o) => {
                      const optionId = `${id}-${o.value}`;
                      const on = (draft.set[f.key] ?? []).includes(o.value);
                      return (
                        <label key={o.value} className={v.row} htmlFor={optionId}>
                          <input
                            id={optionId}
                            type="checkbox"
                            checked={on}
                            aria-describedby={helpId}
                            onChange={(e) =>
                              setDraft((d) => {
                                const cur = d.set[f.key] ?? [];
                                return { ...d, set: { ...d.set, [f.key]: e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value) } };
                              })
                            }
                          />
                          <span>{o.label}</span>
                        </label>
                      );
                    })}
                    {(() => {
                      const unlisted = (draft.set[f.key] ?? []).filter((x) => !f.options.some((o) => o.value === x));
                      return unlisted.length > 0 && !f.loading ? (
                        <p className={v.faint}>{unlisted.length} stored entr{unlisted.length === 1 ? "y" : "ies"} not in this list {unlisted.length === 1 ? "is" : "are"} kept as {unlisted.length === 1 ? "it is" : "they are"}.</p>
                      ) : null;
                    })()}
                  </Fieldset>
                  {help}
                </div>
              );
            case "secret": {
              const clearId = `${id}-clear`;
              return (
                <div key={f.key}>
                  <Field label={f.label}>
                    <Input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      value={draft.text[f.key] ?? ""}
                      maxLength={f.maxLength}
                      placeholder="leave blank to keep the stored one"
                      disabled={draft.clear[f.key]}
                      aria-describedby={helpId}
                      onChange={(e) => setText(f.key, e.target.value)}
                    />
                  </Field>
                  {f.clearLabel ? (
                    <label className={v.row} htmlFor={clearId}>
                      <input
                        id={clearId}
                        type="checkbox"
                        checked={draft.clear[f.key] ?? false}
                        onChange={(e) => setDraft((d) => ({ ...d, clear: { ...d.clear, [f.key]: e.target.checked } }))}
                      />
                      <span>{f.clearLabel}</span>
                    </label>
                  ) : null}
                  {help}
                </div>
              );
            }
          }
        })}
        {!result.ok ? <p className={v.faint}>{result.problem}</p> : null}
        {error ? (
          <p className={v.errLine} role="alert">
            {error}
          </p>
        ) : null}
        {/* Enter in a field submits; the visible button is in the dialog's actions */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
