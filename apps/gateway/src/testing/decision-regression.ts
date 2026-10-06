/**
 * ADR-0182 (D4) A11 test fixture: write the review policy, the required tests
 * or an intake template variant the way an admin must under the strict
 * `decision_regression_gate` default (`enforce`) — preview the exact body
 * first, then submit it with the run's id and, when outcomes change, an
 * accepted reason. Nothing is relaxed.
 *
 * A suite that pins something the gate would otherwise serialise (concurrent
 * writers, say) may relax the gate through the AUDITED settings route with
 * `setDecisionRegressionGateForTest`, whose `restore()` puts the strict
 * default back (M-068: call it in a `finally` or the file's afterAll).
 */
import type { LightMyRequestResponse } from "fastify";
import type { DecisionRegressionSubject } from "@regulait/shared";

type Headers = Record<string, string>;
interface Injectable {
  inject: (opts: { method: "GET" | "POST" | "PUT"; url: string; headers: Headers; payload?: object }) => Promise<LightMyRequestResponse> | PromiseLike<LightMyRequestResponse>;
}

export const TEST_ACCEPT_REASON = "test fixture: the outcomes this change alters are the ones under test";

/** preview `candidate`, and return the fields its activation write carries */
export async function regressionAcceptance(
  app: Injectable,
  headers: Headers,
  subject: DecisionRegressionSubject,
  candidate: unknown,
): Promise<{ regressionRunId: string; acceptChangedOutcomes: true; acceptReason: string }> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/governance/decision-regression/preview",
    headers,
    payload: { subject, candidate: candidate as object },
  });
  if (r.statusCode !== 201) throw new Error(`decision-regression preview failed: ${r.statusCode} ${r.body}`);
  return { regressionRunId: (r.json() as { id: string }).id, acceptChangedOutcomes: true, acceptReason: TEST_ACCEPT_REASON };
}

/** preview `body`, then PUT it with the acceptance fields */
export async function previewedPut(
  app: Injectable,
  url: string,
  headers: Headers,
  subject: "review_policy" | "required_tests",
  body: unknown,
): Promise<LightMyRequestResponse> {
  const acceptance = await regressionAcceptance(app, headers, subject, body);
  return app.inject({ method: "PUT", url, headers, payload: { ...(body as object), ...acceptance } });
}

/** relax (or restore) the gate through the audited `PUT /v1/org/settings`;
 * the returned `restore()` puts `enforce` back */
export async function setDecisionRegressionGateForTest(
  app: Injectable,
  adminHeaders: Headers,
  mode: "off" | "warn" | "enforce",
): Promise<() => Promise<void>> {
  const put = async (m: string) => {
    const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: adminHeaders, payload: { decisionRegressionGate: m } });
    if (r.statusCode !== 200) throw new Error(`setting decision_regression_gate=${m} failed: ${r.statusCode} ${r.body}`);
  };
  await put(mode);
  return () => put("enforce");
}
