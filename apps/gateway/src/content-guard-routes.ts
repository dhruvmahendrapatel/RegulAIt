/**
 * ADR-0232 (PENDING S6) — the existing-rows REPORT for the content-credential guard.
 *
 * The guard refuses NEW credential-shaped text in name/title/description/summary/body columns. Rows written
 * before it are reported here and never rewritten: rewriting stored content is an edit to the record, and
 * the person who owns the record is the one who should change it. The report returns where (table, column,
 * row id) and what kind (rule labels), never the value. Admin-only (the gateway's default for /v1/admin).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contentCredentialReport, type Db } from "@regulait/db";

const reportQuery = z
  .object({ perColumnLimit: z.coerce.number().int().min(1).max(500).default(50) })
  .strict();

export function registerContentGuardRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/admin/content-credential-report", async (req) => {
    const q = reportQuery.parse(req.query);
    const report = await contentCredentialReport(db as unknown as Parameters<typeof contentCredentialReport>[0], {
      perColumnLimit: q.perColumnLimit,
    });
    return { ...report, generatedAt: new Date().toISOString() };
  });
}
