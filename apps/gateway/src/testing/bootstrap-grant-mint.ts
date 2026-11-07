/**
 * Vitest setup file (apps/gateway/vitest.config.ts `setupFiles`) — TEST ONLY.
 *
 * ADR-0250 (review S-04): the eight grant-mint POSTs are a `settings_relax` step-up. Some 180 suites mint grants in
 * their setup with the bootstrap credential, which passes a step-up only while no active admin can give one (B4S-06).
 * On the shared test database an earlier suite may leave such an admin behind, so the same setup mint passes or is
 * refused depending on vitest's file order: the reason relaxStepUpAround exists, and every suite that posts an egress
 * relaxation through the bootstrap credential already wraps that post in it.
 *
 * This applies the same wrapper to grant-mint SETUP, in one place instead of 180: a POST to one of the eight mint
 * routes that the gateway refuses ONLY because an admin can now step up (403 `step_up_required`,
 * `credential: "bootstrap"`) is sent once more inside relaxStepUpAround on the suite database (DATABASE_URL), exactly
 * as a suite would by hand. Nothing else is touched: an API key's or a session's mint, and every other refusal, reach
 * the test unchanged, so the step-up itself stays under test (adr0250-grant-mint-step-up.test.ts mints with an admin
 * key and a session).
 *
 * It hooks each Fastify instance through Fastify's own `fastify.initialization` diagnostics channel and wraps that
 * instance's `inject`. It imports NO gateway module at load time (no vi.mock of app.js, no static import of
 * step-up-posture): a setup file loads before a suite's own vi.mock()s are registered, so any gateway module it loaded
 * would be cached unmocked for that suite (audit-timestamp.test.ts mocks DNS and the pinned fetch).
 */
import diagnostics from "node:diagnostics_channel";
import { afterAll } from "vitest";
import { createDb, type Db } from "@regulait/db";

const MINT_ROUTE = /^\/v1\/(grants\/(tools|servers|agents|connectors)|roles\/[^/]+\/grants\/(tools|servers|agents|connectors))$/;

type InjectOpts = { method?: string; url?: string };
type InjectRes = { statusCode: number; body: string };
type Injectable = { inject: (o?: unknown) => unknown };

let db: Db | null = null;
const suiteDb = (): Db => {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("bootstrap-grant-mint: DATABASE_URL must name the test database");
    db = createDb(url);
  }
  return db;
};
afterAll(async () => {
  if (db) await db.$client.end();
  db = null;
});

function refusedOnlyForBootstrap(res: InjectRes): boolean {
  if (res.statusCode !== 403) return false;
  try {
    const body = JSON.parse(res.body) as { error?: string; credential?: string };
    return body.error === "step_up_required" && body.credential === "bootstrap";
  } catch {
    return false;
  }
}

function wrap(app: Injectable): void {
  const inject = app.inject.bind(app);
  app.inject = (o?: unknown) => {
    // only the object form, which every suite uses; the chained (no-argument) form passes straight through
    if (!o || typeof o !== "object") return inject(o);
    const req = o as InjectOpts;
    const url = (req.url ?? "").split("?")[0]!;
    if (req.method !== "POST" || !MINT_ROUTE.test(url)) return inject(o);
    return (async () => {
      const res = (await inject(o)) as InjectRes;
      if (!refusedOnlyForBootstrap(res)) return res;
      // imported here, not at the top: a setup file's static imports load before a suite registers its vi.mock()s,
      // and step-up-posture's graph would then cache gateway modules unmocked for that suite
      const { relaxStepUpAround } = await import("./step-up-posture.js");
      try {
        return await relaxStepUpAround(suiteDb(), async () => (await inject(o)) as InjectRes);
      } catch {
        // the app runs on another database (a suite's own scratch database), which this cannot relax: the suite sees
        // the original refusal, as it would without this file
        return res;
      }
    })();
  };
}

const onInit = (message: unknown) => {
  const app = (message as { fastify?: Injectable }).fastify;
  if (app && typeof app.inject === "function") wrap(app);
};
diagnostics.subscribe("fastify.initialization", onInit);
afterAll(() => {
  diagnostics.unsubscribe("fastify.initialization", onInit);
});
