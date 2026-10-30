/**
 * ADR-0213 (backlog P6) — drafted answers for the vendor assessment
 * questionnaire, inside the vendor detail's questionnaire card.
 *
 * The panel only ever fills the questionnaire text area: "Submit
 * questionnaire" and "Record attestation" stay the only writes, and both stay
 * a person's act. Each drafted section carries its source line in the text
 * itself (so the submitted artifact keeps it); a section nothing grounds keeps
 * the blank form's prompt. A refusal (drafts off, no model connection) is shown
 * here, beside the button that was refused.
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

interface DraftResponse {
  sections: DraftSection[];
  model:
    | { status: "not_requested" }
    | { status: "refused" | "failed" | "unparseable"; reason: string }
    | { status: "drafted"; source: "model" | "mock"; sections: string[] };
  draft: string;
  disclaimer: string;
}

export function VendorDraftPanel(props: { vendorId: string; onUseDraft: (text: string) => void }) {
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
      props.onUseDraft(out.draft);
    }, null);

  const m = result?.model;

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
          Draft answers into the questionnaire
        </Button>
      </div>

      {act.guidance ? <RefusalNotice guidance={act.guidance} /> : act.error && <div role="alert">{act.error}</div>}
      {m?.status === "refused" && <RefusalNotice guidance={REFUSAL_GUIDANCE.vendorDraftNoModel} />}
      {(m?.status === "failed" || m?.status === "unparseable") && (
        <div role="alert" className={v.faint}>
          Model draft not used: {m.reason}
        </div>
      )}

      {result && (
        <div className={v.faint} role="status" data-testid="vendor-draft-result">
          {result.sections.filter((x) => x.source !== "none").length} of 6 sections drafted below, each labelled with its
          sources. Check them before you submit.
        </div>
      )}
    </div>
  );
}
