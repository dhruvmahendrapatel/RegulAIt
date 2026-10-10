/**
 * ADR-0186 A2+B test fixture: the strict approval-signing defaults, and the
 * honest way a suite about something ELSE copes with them.
 *
 * Under the strict defaults every tool-call approval (`mcp_tool`,
 * `connector_call`) is signed with a passkey over the exact call
 * (`approval_signature_mode = passkey`), and a call attributed to a project
 * carrying an in-app-only data classification needs two approvers
 * (`tool_approval_sensitive_quorum = 2`). A suite that pins pre-0186 approval
 * behaviour through API keys, chat taps or bulk turns signing off and the
 * sensitive quorum down to 1 for its own run, explicitly, and puts the strict
 * values back in its afterAll (M-068: global state is removed before the spec
 * ends) — the `relaxStepUpForTest` pattern. The snapshot is taken at QUEUE
 * time, so relax before the suite queues anything.
 *
 * What it does NOT relax: the caller can still never approve their own call,
 * an admin outside the approver pool still cannot override a tool call, and a
 * delegator and their delegate still count once. Dual control and signing are
 * proved under the strict values in `zz-b4ab-dual-control-signed-approvals.test.ts`.
 */
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { eq, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import { loadOrgSettings } from "../org-settings.js";

/** turn approval signing off (and the sensitive quorum to 1) for this suite; the returned function restores the strict values */
export async function relaxApprovalSigningForTest(db: Db): Promise<() => Promise<void>> {
  await loadOrgSettings(db); // the singleton exists
  await db
    .update(orgSettings)
    .set({ approvalSignatureMode: "off", toolApprovalSensitiveQuorum: 1 })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db
      .update(orgSettings)
      .set({
        approvalSignatureMode: BATCH4_STRICT_DEFAULTS.approvalSignatureMode,
        toolApprovalSensitiveQuorum: BATCH4_STRICT_DEFAULTS.toolApprovalSensitiveQuorum,
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}
