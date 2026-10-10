/**
 * Chat: a message sent while the open thread's history is still loading keeps
 * its live reply and governance trace.
 *
 * The page opens the newest thread on arrival and restores its history from
 * the server. A send that raced that restore used to void it; when the stream
 * ended the restore ran again and replaced the live exchange with the stored
 * history, which carries no trace (seen in CI on spa-journeys, phase1 "chat").
 * The first history request here is held back long enough that the message is
 * always sent before it lands.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const CONVO = "c0nv0000-0000-4000-8000-0000000000a1";
const HOLD_FIRST_HISTORY_MS = 1500;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const priorTurn = [
  { role: "user", content: "Summarize the plan.", createdAt: "2026-10-08T00:00:00Z" },
  { role: "assistant", content: "The plan is sound.", agentId: AGENT, createdAt: "2026-10-08T00:00:01Z" },
];

async function mockApi(page: Page) {
  const cap = { historyGets: 0, invokes: [] as Array<Record<string, unknown>>, sent: [] as string[] };
  const me = { userId: "u", isAdmin: false, user: { id: "u", email: "dana@example.test", displayName: "Dana Developer" } };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users/u/agents") {
      return json(route, {
        agents: [{ agentId: AGENT, name: "balanced-mock", provider: "mock", model: "mock-balanced", tier: 1, enabled: true, revoked: false, source: "direct", roles: [] }],
        defaultAgentId: AGENT,
      });
    }
    if (p === "/v1/model-providers/status") return json(route, { providers: { mock: { configured: true } } });
    if (p === "/v1/users/u/model-credentials") return json(route, { credentials: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/conversations" && method === "GET") {
      return json(route, { conversations: [{ id: CONVO, title: "Summarize the plan.", agentId: AGENT, projectId: null, messageCount: 2 + cap.sent.length * 2, updatedAt: "2026-10-08T00:00:01Z" }] });
    }
    if (p === `/v1/conversations/${CONVO}` && method === "GET") {
      cap.historyGets += 1;
      if (cap.historyGets === 1) await new Promise((r) => setTimeout(r, HOLD_FIRST_HISTORY_MS));
      // the stored thread, as the server would return it: no decision/routing
      const stored = cap.sent.flatMap((content) => [
        { role: "user", content, createdAt: "2026-10-08T00:01:00Z" },
        { role: "assistant", content: "Stored reply.", agentId: AGENT, createdAt: "2026-10-08T00:01:01Z" },
      ]);
      return json(route, { id: CONVO, agentId: AGENT, projectId: null, messages: [...priorTurn, ...stored] });
    }
    if (p === `/v1/agents/${AGENT}/invoke` && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      cap.invokes.push(body);
      cap.sent.push(String(body.input));
      return json(route, {
        decision: { effect: "allow", ruleId: "grant-direct", reason: "user holds a direct grant for 'balanced-mock'" },
        routing: { effect: "allow", selectedAgentId: AGENT },
        dispatch: { model: "mock-balanced", costUsd: 0, outputText: "RegulAIt governs every model call.", usage: { inputTokens: 8, outputTokens: 6 }, credentialSource: "platform" },
      });
    }
    return json(route, {});
  });
  return cap;
}

test("a message sent before the thread's history loads keeps its live reply and governance trace", async ({ page }) => {
  const cap = await mockApi(page);
  await page.goto("/ui/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
  await expect(page.getByLabel("Agent")).toBeVisible();

  // sent while the first history request is still held
  await page.getByLabel("Message").fill("Summarize what RegulAIt governs in one sentence.");
  await page.getByLabel("Message").press("Enter");
  await expect.poll(() => cap.invokes.length).toBe(1);
  expect(cap.invokes[0]!.conversationId).toBe(CONVO);

  await expect(page.getByText("RegulAIt governs every model call.")).toBeVisible();
  await expect(page.getByText("governance trace").last()).toBeVisible();

  // let the held request land, and anything it would trigger settle
  await page.waitForTimeout(HOLD_FIRST_HISTORY_MS + 500);
  await expect(page.getByText("RegulAIt governs every model call.")).toBeVisible();
  await expect(page.getByText("governance trace").last()).toBeVisible();
  await expect(page.getByText("Stored reply.")).toHaveCount(0);
  // the thread's earlier turn is shown above the new one
  await expect(page.getByText("The plan is sound.")).toBeVisible();
});
