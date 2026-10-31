/**
 * ADR-0213 (backlog P6) — drafted answers for the vendor assessment
 * questionnaire, inside the vendor detail's questionnaire card.
 *
 * Drafting changes nothing by itself. The assessor accepts each drafted answer
 * into its own section ("Use this answer"); "Use drafts in unanswered sections"
 * fills only sections still at the blank form's prompt, and replacing a section
 * the assessor already wrote takes its own, explicitly labelled click — typed
 * answers are never overwritten silently. An accepted answer carries its source
 * line in the text, so the submitted artifact keeps it. "Submit questionnaire"
 * and "Record attestation" stay the only writes, and both stay a person's act.
 * A refusal (drafts off, no model connection) is shown here, beside the button
 * that was refused.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import { REFUSAL_GUIDANCE } from "../../../api/refusals";
import { Button, Field, Select, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type DraftSource = "rules" | "model" | "mock" | "none";

interface DraftSection {
  id: string;
  heading: string;
  text: string;
  source: DraftSource;
  cites: Array<{ id: string; kind: string; label: string }>;
}

const SOURCE_LABEL: Record<DraftSource, string> = {
  rules: "Drafted from records",
  model: "Drafted by a model",
  mock: "Drafted by a model",
  none: "Not drafted",
};

/** the body under `## heading` in a questionnaire, or null when the heading is missing */
function sectionBody(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim() === heading);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** `text` with the body under `## heading` replaced (the section is appended when missing) */
function withSection(text: string, heading: string, body: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim() === heading);
  if (at < 0) return `${text.trimEnd()}\n\n## ${heading}\n${body}\n`;
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  const tail = end < 0 ? [] : ["", ...lines.slice(end)];
  return [...lines.slice(0, at + 1), body, ...tail].join("\n");
}

/** the accepted answer as it goes into the questionnaire: its source line, then the text */
const labelled = (s: DraftSection) =>
  `> ${SOURCE_LABEL[s.source]} — from: ${s.cites.map((c) => c.label).join("; ")}. Check it against the vendor's own answer before submitting.\n\n${s.text}`;

interface DraftResponse {
  sections: DraftSection[];
  model:
    | { status: "not_requested" }
    | { status: "refused" | "failed" | "unparseable"; reason: string }
    | { status: "drafted"; source: "model" | "mock"; sections: string[] };
  draft: string;
  disclaimer: string;
}

export function VendorDraftPanel(props: {
  vendorId: string;
  /** the questionnaire text as it stands (typed answers or the blank form) */
  current: string;
  /** the blank form, to tell an unanswered section from one the assessor wrote */
  template: string;
  onChange: (text: string) => void;
}) {
  const act = useAction();
  const [mode, setMode] = useState<"records" | "model">("records");
  const [doc, setDoc] = useState("");
  const [result, setResult] = useState<DraftResponse | null>(null);

  const draft = () =>
    void act.run(async () => {
      setResult(null);
      const out = await api.post<DraftResponse>(`/v1/vendors/${props.vendorId}/questionnaire/draft`, {
        useModel: mode === "model",
        supplierDocuments: doc.trim() ? [{ name: "Supplier document", text: doc.trim() }] : [],
      });
      setResult(out);
    }, null);

  const m = result?.model;
  const drafted = (result?.sections ?? []).filter((x) => x.source !== "none" && x.text.trim());
  /** the assessor has written something in this section (it is no longer the blank prompt) */
  const answered = (x: DraftSection) => {
    const now = sectionBody(props.current, x.heading);
    return now !== null && now !== "" && now !== sectionBody(props.template, x.heading);
  };
  const useAllUnanswered = () =>
    props.onChange(drafted.filter((x) => !answered(x)).reduce((t, x) => withSection(t, x.heading, labelled(x)), props.current));

  return (
    <div className={v.stack} data-testid="vendor-draft-panel">
      <div className={v.faint}>
        Optional: draft answers from our records and a supplier document. Drafts only fill the text below.
      </div>
      <div className={a.formRow}>
        <Field label="Draft with">
          <Select value={mode} onChange={(e) => setMode(e.target.value as "records" | "model")}>
            <option value="records">records only (default)</option>
            <option value="model">records and a model</option>
          </Select>
        </Field>
      </div>
      {mode === "model" && (
        <Field label="Supplier document (pasted text)">
          <Textarea rows={5} value={doc} maxLength={20_000} onChange={(e) => setDoc(e.target.value)} />
        </Field>
      )}
      <div>
        <Button aria-disabled={act.busy} onClick={() => !act.busy && draft()}>
          Draft answers
        </Button>
      </div>

      {act.guidance ? <RefusalNotice guidance={act.guidance} /> : act.error && <div role="alert">{act.error}</div>}
      {m?.status === "refused" && (
        <>
          <RefusalNotice guidance={REFUSAL_GUIDANCE.vendorDraftNoModel} />
          <div className={v.faint}>Reason: {m.reason}</div>
        </>
      )}
      {(m?.status === "failed" || m?.status === "unparseable") && (
        <div role="alert" className={v.faint}>
          Model draft not used: {m.reason}
        </div>
      )}

      {result && (
        <div className={v.stack} data-testid="vendor-draft-result">
          <div className={v.faint} role="status">
            {drafted.length} of {result.sections.length} sections drafted. Nothing changes in the questionnaire until you
            use an answer.
          </div>
          {drafted.map((x) => (
            <div key={x.id} className={v.stack} data-testid={`vendor-draft-section-${x.id}`}>
              <strong>{x.heading}</strong>
              <div className={v.faint}>
                {SOURCE_LABEL[x.source]} — from: {x.cites.map((c) => c.label).join("; ")}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{x.text}</div>
              <div>
                <Button onClick={() => props.onChange(withSection(props.current, x.heading, labelled(x)))}>
                  {answered(x) ? `Replace my answer to ${x.heading}` : `Use this answer for ${x.heading}`}
                </Button>
              </div>
            </div>
          ))}
          {drafted.some((x) => !answered(x)) && (
            <div>
              <Button onClick={useAllUnanswered}>Use drafts in unanswered sections</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
