/**
 * ADR-0182 (ADR-0175 batch D4) A13 — THE FEEDBACK FORM. OWNER: A13 (D4).
 *
 * One component, two routes (App.tsx, P0's):
 *   /feedback/:useCaseId  signed in, inside the app shell;
 *   /f/:token             PUBLIC, no app chrome: a person outside the
 *                         organisation reports a problem or appeals a decision
 *                         through a signed link (shipped OFF; the gateway
 *                         answers 404 while the setting is off).
 *
 * FOUNDATION STUB (P0). Until A13 lands it submits nothing and says so.
 */
import { useParams } from "react-router-dom";
import { Card, EmptyState } from "../../ui/kit";

export default function FeedbackFormPage(props: { public?: boolean }) {
  const { useCaseId, token } = useParams();
  const subject = props.public ? (token ? "this link" : "") : useCaseId ? "this use case" : "";
  return (
    <main style={props.public ? { maxWidth: 640, margin: "0 auto", padding: "var(--s5)" } : undefined}>
      <h1>Report a problem or appeal a decision</h1>
      <Card>
        <EmptyState
          title="Not built yet"
          body={`Feedback for ${subject || "a use case"} arrives with batch D4 (A13). Nothing is submitted from this page yet.`}
        />
      </Card>
    </main>
  );
}
