/**
 * The small pure pieces behind the governance UI-gap batch: the refusal copy
 * helper, the shadow-AI workflow body, the drift-sweep and anchor sentences.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { refusalSentence, withRefusalCopy } from "./refusalCopy";
import { startFormFrom, startInstanceBody, type RemediationPlan } from "./shadowRemediationModel";
import { driftSweepSentence } from "./EvalsSummaryCard";
import { captureSentence, flushSentence } from "./AnchorTimestampsPanel";
import { remediationTone } from "./RemediationsCard";

describe("refusal copy", () => {
  const map = { invalid_timezone: "That timezone is not known." };
  it("says a mapped refusal in the screen's words, with the server's detail", () => {
    expect(refusalSentence(new ApiError(422, { error: "invalid_timezone" }), map)).toBe("That timezone is not known.");
    expect(refusalSentence(new ApiError(422, { error: "invalid_timezone", detail: "'Mars/Base' is not IANA" }), map)).toBe(
      "That timezone is not known. 'Mars/Base' is not IANA",
    );
  });
  it("leaves every other refusal exactly as it was", async () => {
    const stepUp = new ApiError(403, { error: "step_up_required" });
    expect(refusalSentence(stepUp, map)).toBeNull();
    await expect(withRefusalCopy(async () => { throw stepUp; }, map)).rejects.toBe(stepUp);
    await expect(withRefusalCopy(async () => { throw new ApiError(422, { error: "invalid_timezone" }); }, map)).rejects.toThrow("That timezone is not known.");
    await expect(withRefusalCopy(async () => 7, map)).resolves.toBe(7);
  });
});

describe("shadow-AI remediation workflow body", () => {
  const plan: RemediationPlan = {
    findingId: "f1",
    subject: "acme/billing",
    provider: "openai",
    severity: "high",
    replacementAgent: null,
    steps: [],
    // the gateway's body, already shaped to startInstanceSchema; only the environment is a placeholder
    workflowRequest: {
      route: "POST /v1/workflows/instances",
      body: {
        change: {
          description: "Pull acme/billing (openai) into governance — shadow-AI finding f1",
          paths: ["acme/billing"],
          changeType: "shadow-ai-remediation",
          environment: "unstated",
          targetSystem: "acme/billing",
        },
      },
      needsInput: ["change.environment"],
    },
    note: "",
  };
  it("takes the plan's body and replaces the placeholder environment with the stated one", () => {
    const built = startInstanceBody(plan, { ...startFormFrom(plan), environment: "production" });
    expect(built).toEqual({
      ok: true,
      body: {
        change: {
          description: "Pull acme/billing (openai) into governance — shadow-AI finding f1",
          paths: ["acme/billing"],
          changeType: "shadow-ai-remediation",
          environment: "production",
          targetSystem: "acme/billing",
        },
      },
    });
  });
  it("has no repo path for a non-repo subject, bills a chosen project, and needs a description", () => {
    const host = {
      ...plan,
      workflowRequest: {
        ...plan.workflowRequest,
        body: { change: { description: "Pull app.example (openai) into governance", paths: [], changeType: "shadow-ai-remediation", environment: "unstated", targetSystem: "app.example" } },
      },
    };
    const built = startInstanceBody(host, { ...startFormFrom(host), environment: "production", projectId: "p1" });
    expect(built.ok && built.body).toMatchObject({ projectId: "p1", change: { paths: [], targetSystem: "app.example" } });
    expect(startInstanceBody(plan, { ...startFormFrom(plan), environment: "production", description: " " })).toMatchObject({ ok: false });
    expect(startInstanceBody(plan, { ...startFormFrom(plan), environment: "" })).toMatchObject({ ok: false });
  });
  it("validates against the gateway's start schema", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/index.ts", import.meta.url).pathname);
    const built = startInstanceBody(plan, { ...startFormFrom(plan), environment: "production" });
    expect(built.ok && shared.startInstanceSchema.safeParse(built.body).success).toBe(true);
    // the shared index is large; importing it cold takes a few seconds under load
  }, 60_000);
});

describe("result sentences", () => {
  it("drift sweep", () => {
    expect(driftSweepSentence({ ran: [], skipped: [] })).toBe("No pinned baselines to re-run.");
    expect(
      driftSweepSentence({
        ran: [
          { datasetId: "d", agentId: "a", runId: "r", regression: true, scoreDelta: -0.1, trigger: "scheduled" },
          { datasetId: "d2", agentId: "a", runId: "r2", regression: false, scoreDelta: 0, trigger: "scheduled" },
        ],
        skipped: [{ datasetId: "d3", agentId: null, reason: "pinner gone" }],
      }),
    ).toBe("2 pinned baselines re-run, 1 regressed, 1 skipped.");
  });
  it("anchoring states where the anchor went and whether it is evidence", () => {
    const base = { anchorId: "a", seq: 42, rowHash: "0".repeat(64), externalRef: null, error: null };
    expect(captureSentence({ ...base, destination: "none", status: "pending", tamperResistant: false })).toBe(
      "Anchored the chain at row 42: waiting to be written out, to this database only (no anchor sink is configured). This destination is not tamper-resistant, so it is a consistency check, not evidence.",
    );
    expect(captureSentence({ ...base, destination: "s3_object_lock", status: "flushed", tamperResistant: true })).toBe(
      "Anchored the chain at row 42: written out, to s3 object lock.",
    );
    expect(flushSentence({ attempted: 0, flushed: 0, failed: 0 })).toBe("No anchors were waiting to be written out.");
    expect(flushSentence({ attempted: 3, flushed: 2, failed: 1 })).toBe("2 of 3 waiting anchors written out; 1 failed and stay pending.");
  });
  it("remediation status tones", () => {
    expect(remediationTone("applied")).toBe("ok");
    expect(remediationTone("pending_approval")).toBe("info");
    expect(remediationTone("failed")).toBe("danger");
  });
});
