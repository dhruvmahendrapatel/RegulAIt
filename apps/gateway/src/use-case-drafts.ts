/**
 * ADR-0171 / AER-050 — THE INTAKE WIZARD'S SERVER-SIDE DRAFTS.
 *
 * The wizard's answers used to live only in page memory: a refresh, a
 * session-expiry redirect or a Cancel lost them. These three routes store the
 * wizard's state for the SIGNED-IN USER ONLY:
 *
 *   GET    /v1/use-cases/draft?scope=new|<useCaseId>  → { draft | null }
 *   PUT    /v1/use-cases/draft?scope=…   { state }    → { draft }   (upsert)
 *   DELETE /v1/use-cases/draft?scope=…                → 204
 *
 * WHY SERVER-SIDE. Questionnaire text can be sensitive, so it never belongs in
 * browser storage — here it is behind the same credential as everything else,
 * and only its author can read it back (there is no route that lists or reads
 * another user's draft, admin or not).
 *
 * SCOPE. `new` is the registration wizard; a use-case id is that use case's
 * resubmission, and only someone who may EDIT that use case (its owner or an
 * admin — the PATCH rule) may keep a draft against it. One draft per
 * (user, scope); a save replaces it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. `state` is the wizard's opaque JSON — the
 * gateway never reads inside it, never validates its fields and never treats
 * it as a submission (nothing here creates or changes a use case). There is no
 * audit row per save: a draft is not a governance act, and an audit row per
 * keystroke-debounce would bury the ones that are. Drafts untouched for 30
 * days are pruned by these routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { aiUseCases, and, eq, lt, useCaseDrafts, type Db } from "@regulait/db";
import { putUseCaseDraftSchema, useCaseDraftScopeSchema, USE_CASE_DRAFT_MAX_BYTES } from "@regulait/shared";

/** drafts untouched this long are pruned */
export const USE_CASE_DRAFT_TTL_DAYS = 30;

const draftView = (row: { scope: string; state: Record<string, unknown>; updatedAt: Date }) => ({
  scope: row.scope,
  state: row.state,
  updatedAt: row.updatedAt,
});

/**
 * ADR-0179 security review, item 6 — WHOSE DRAFT A WRITE IS. The wizard
 * names the person whose draft it loaded in this header on every save. A save
 * that was queued or sent as the page went (the keepalive exit save) can
 * arrive after that person signed out and someone else signed in on the same
 * browser; the cookie it carries is then the new person's. A write naming a
 * different person is refused (409 `draft_owner_changed`) and stores nothing.
 * The header is optional: a client that does not send it is unchanged.
 */
export const DRAFT_OWNER_HEADER = "x-regulait-draft-owner";

async function refuseOtherOwner(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<boolean> {
  const named = req.headers[DRAFT_OWNER_HEADER];
  if (named === undefined || named === userId) return false;
  await reply.status(409).send({
    error: "draft_owner_changed",
    detail:
      "this draft belongs to the person who started it, not to the one signed in now; it was not stored under your account",
  });
  return true;
}

async function pruneStaleDrafts(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - USE_CASE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(useCaseDrafts).where(lt(useCaseDrafts.updatedAt, cutoff));
}

/** who may keep a draft in this scope: anyone signed in for `new`; the
 * owner or an admin for a use case (the same rule PATCH applies) */
async function authorizeScope(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; scope: string } | null> {
  const userId = req.authCtx.userId;
  if (!userId) {
    await reply.status(403).send({
      error: "drafts_require_identity",
      detail: "a draft belongs to a person; a token with no user identity cannot keep one",
    });
    return null;
  }
  const { scope } = useCaseDraftScopeSchema.parse(req.query);
  if (scope !== "new") {
    const [useCase] = await db
      .select({ ownerUserId: aiUseCases.ownerUserId })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, scope));
    if (!useCase) {
      await reply.status(404).send({ error: "not_found" });
      return null;
    }
    if (!req.authCtx.isAdmin && useCase.ownerUserId !== userId) {
      await reply.status(403).send({
        error: "forbidden",
        detail: "a draft against a use case can be kept only by someone who may edit it — its owner or an admin",
      });
      return null;
    }
  }
  return { userId, scope };
}

export function registerUseCaseDraftRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/use-cases/draft", async (req, reply) => {
    const who = await authorizeScope(db, req, reply);
    if (!who) return reply;
    await pruneStaleDrafts(db);
    const [row] = await db
      .select()
      .from(useCaseDrafts)
      .where(and(eq(useCaseDrafts.userId, who.userId), eq(useCaseDrafts.scope, who.scope)));
    return { draft: row ? draftView(row) : null };
  });

  app.put("/v1/use-cases/draft", async (req, reply) => {
    const who = await authorizeScope(db, req, reply);
    if (!who) return reply;
    if (await refuseOtherOwner(req, reply, who.userId)) return reply;
    const { state } = putUseCaseDraftSchema.parse(req.body);
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (bytes > USE_CASE_DRAFT_MAX_BYTES) {
      return reply.status(413).send({
        error: "draft_too_large",
        detail: `a draft may hold at most ${USE_CASE_DRAFT_MAX_BYTES} bytes; this one is ${bytes}`,
        limitBytes: USE_CASE_DRAFT_MAX_BYTES,
      });
    }
    await pruneStaleDrafts(db);
    const now = new Date();
    const [row] = await db
      .insert(useCaseDrafts)
      .values({ userId: who.userId, scope: who.scope, state, updatedAt: now })
      .onConflictDoUpdate({
        target: [useCaseDrafts.userId, useCaseDrafts.scope],
        set: { state, updatedAt: now },
      })
      .returning();
    return { draft: draftView(row!) };
  });

  app.delete("/v1/use-cases/draft", async (req, reply) => {
    const who = await authorizeScope(db, req, reply);
    if (!who) return reply;
    if (await refuseOtherOwner(req, reply, who.userId)) return reply;
    await db
      .delete(useCaseDrafts)
      .where(and(eq(useCaseDrafts.userId, who.userId), eq(useCaseDrafts.scope, who.scope)));
    return reply.status(204).send();
  });
}
