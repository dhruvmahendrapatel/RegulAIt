/**
 * ADR-0226 — the list contract's two route bodies, for the lists converted after the pilot.
 *
 * Exactly the pattern `/v1/runs` uses (orchestration.ts): parse the filters with the contract's own keys taken out,
 * build the route's one WHERE (its object-level authorisation and its filters), then answer a page through
 * `runListPage` or the Excel file through `sendListExport`. This file only names those steps once, so each route
 * declares its `ListSpec`, its reader and its WHERE and nothing else; it adds no behaviour of its own.
 *
 * `where` returns `null` to refuse (the route's old refusal, e.g. a bootstrap credential with no own rows), which is
 * answered with `refusal` before anything is read.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { sql, type Db, type PgColumn, type SQL } from "@regulait/db";
import {
  filterParams,
  parseListExport,
  parseListPage,
  runListPage,
  sendListError,
  sendListExport,
  type ListReader,
  type ListSpec,
} from "./list-contract.js";

export interface ContractList<Row, F> {
  spec: ListSpec<Row>;
  reader: ListReader<Row>;
  /** the list's filter params (a `.strict()` schema: an unknown param is a 400) */
  filters: z.ZodType<F>;
  /** the route's one predicate for the page, the count and the export; `null` refuses */
  where: (req: FastifyRequest, f: F) => SQL | undefined | null | Promise<SQL | undefined | null>;
  refusal?: { status: number; body: Record<string, unknown> };
  /** keys a page answers beside the contract's own (a disclaimer, a note), never rows */
  extra?: (req: FastifyRequest, f: F) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

const definedOnly = (f: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries((f ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined));

/** one page of the list under the contract (the caller checked `wantsListContract`) */
export async function answerListPage<Row, F>(db: Db, req: FastifyRequest, reply: FastifyReply, list: ContractList<Row, F>) {
  try {
    const q = req.query as Record<string, unknown>;
    const f = list.filters.parse(filterParams(q));
    const page = parseListPage(list.spec, q);
    const where = await list.where(req, f);
    if (where === null) return reply.status(list.refusal?.status ?? 403).send(list.refusal?.body ?? { error: "forbidden" });
    const [out, extra] = await Promise.all([runListPage(db, list.spec, list.reader, where, page), list.extra?.(req, f) ?? {}]);
    return { ...extra, ...out };
  } catch (e) {
    return sendListError(reply, e);
  }
}

/** the list's Excel export: the same filters and WHERE, the requested columns in order, audited */
export async function answerListExport<Row, F>(db: Db, req: FastifyRequest, reply: FastifyReply, list: ContractList<Row, F>) {
  try {
    const q = req.query as Record<string, unknown>;
    const f = list.filters.parse(filterParams(q));
    const ex = parseListExport(list.spec, q);
    const where = await list.where(req, f);
    if (where === null) return reply.status(list.refusal?.status ?? 403).send(list.refusal?.body ?? { error: "forbidden" });
    await sendListExport(db, req, reply, list.spec, list.reader, where, ex, definedOnly(f));
    return reply;
  } catch (e) {
    return sendListError(reply, e);
  }
}

/**
 * A non-admin's narrowing for a generated artifact (ADR-0047's report-run rule, also applied to billing statements
 * and compliance-pack reports), in SQL so the page, the count and the export agree: never an org-scoped artifact,
 * and only one whose frozen project set lies wholly inside the caller's own projects. The same test the routes ran
 * in memory (`effectiveProjectIds.every((p) => mine.has(p))`); an empty set passes it, as it did there.
 */
export function regenerableBy(scopeCol: SQL | PgColumn, projectIdsCol: SQL | PgColumn, mine: readonly string[]): SQL {
  return sql`(${scopeCol} <> 'org' and ${projectIdsCol} is not null and ${projectIdsCol} <@ ${JSON.stringify([...mine])}::jsonb)`;
}
