/**
 * Vitest setup file (apps/gateway/vitest.config.ts `setupFiles`) — TEST ONLY.
 *
 * ADR-0250 (review S-04): the eight grant-mint POSTs are a `settings_relax` step-up. Some 180 suites mint grants in
 * their setup with the bootstrap credential, which passes a step-up only while no active admin can give one (B4S-06).
 * On the shared test database an earlier suite may leave such an admin behind, so the same setup mint passes or is
 * refused depending on vitest's file order: the reason relaxStepUpAround exists, and every suite that posts an egress
 * relaxation through the bootstrap credential already wraps that post in it.
 *
 * This applies the same wrapper to grant-mint SETUP, in one place instead of 180: a BOOTSTRAP-credential POST to one of
 * the eight mint routes that the gateway refuses ONLY because an admin can now step up (403 `step_up_required`,
 * `credential: "bootstrap"`) is sent once more inside relaxStepUpAround, exactly as a suite would by hand. Nothing else
 * is touched: an API key's or a session's mint, and every other refusal, reach the test unchanged, so the step-up
 * itself stays under test (adr0250-grant-mint-step-up.test.ts mints with an admin key and a session).
 */
import { vi } from "vitest";
import type { Db } from "@regulait/db";
import { relaxStepUpAround } from "./step-up-posture.js";

const MINT_ROUTE = /^\/v1\/(grants\/(tools|servers|agents|connectors)|roles\/[^/]+\/grants\/(tools|servers|agents|connectors))$/;

type InjectOpts = { method?: string; url?: string; headers?: Record<string, unknown> };
type InjectRes = { statusCode: number; body: string };

function refusedOnlyForBootstrap(res: InjectRes): boolean {
  if (res.statusCode !== 403) return false;
  try {
    const body = JSON.parse(res.body) as { error?: string; credential?: string };
    return body.error === "step_up_required" && body.credential === "bootstrap";
  } catch {
    return false;
  }
}

vi.mock("../app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app.js")>();
  const buildApp = ((db: Db, opts: Parameters<typeof original.buildApp>[1] = {}) => {
    const app = original.buildApp(db, opts);
    const token = opts.bootstrapToken;
    if (!token) return app;
    const inject = (app.inject as unknown as (o: unknown) => Promise<InjectRes>).bind(app);
    (app as unknown as { inject: unknown }).inject = (o: unknown) => {
      // only the object form, which every suite uses; the chained (no-argument) form passes straight through
      if (!o || typeof o !== "object") return (inject as (o?: unknown) => unknown)(o);
      const req = o as InjectOpts;
      const url = (req.url ?? "").split("?")[0]!;
      const auth = req.headers?.authorization;
      if (req.method !== "POST" || !MINT_ROUTE.test(url) || auth !== `Bearer ${token}`) return inject(o);
      return (async () => {
        const res = await inject(o);
        return refusedOnlyForBootstrap(res) ? relaxStepUpAround(db, () => inject(o)) : res;
      })();
    };
    return app;
  }) as typeof original.buildApp;
  return { ...original, buildApp };
});
