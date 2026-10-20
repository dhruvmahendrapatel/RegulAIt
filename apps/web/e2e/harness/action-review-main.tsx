// Dev-server only (adr0186-ab-signed-approvals.mock.spec.ts): mounts one McpActionReview with Inbox-style decision
// controls and WITHOUT StrictMode. StrictMode re-runs the effects parent first in development, which happens to
// register the review's own Tab trap after the kit dialog's and so hides the order a production build has. Never
// part of the build.
import { createRoot } from "react-dom/client";
import "../../src/theme/tokens.css";
import "../../src/theme/global.css";
import type { Approval } from "../../src/api/types";
import { Button, Input } from "../../src/ui/kit";
import { McpActionReview } from "../../src/views/approvals/McpActionReview";

const approval = {
  id: "a-tool-1",
  status: "pending",
  objectType: "mcp_tool",
  stageId: null,
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  userId: "u-dana",
  approverUserId: "u-avery",
  toolName: "write_file",
  serverId: "s-repo",
  serverName: "repo",
  requestedByName: "Dana Developer",
  argumentsDigest: "a".repeat(64),
  argumentsPreview: { path: "README.md", content: "hello" },
  argumentsPreviewKind: "arguments_v1",
  approvalScope: "action",
  contextDigest: "b".repeat(64),
  expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  boundTarget: { host: "repo.example.test", allowPrivateRanges: false, admissionManifestDigest: null },
} as unknown as Approval;

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16 }}>
    <McpActionReview
      approval={approval}
      controls={(blocked) => (
        <>
          <Input aria-label="Decision reason" placeholder="Reason (optional)" />
          <Button size="sm">Deny</Button>
          <Button size="sm" variant="primary" disabled={!!blocked}>Approve</Button>
        </>
      )}
    />
  </main>,
);
