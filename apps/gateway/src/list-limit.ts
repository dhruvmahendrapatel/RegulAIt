/**
 * REL-10 — the bound on the whole-table list routes.
 *
 * `GET /v1/users` and `GET /v1/agents` returned every row with no cap, on
 * every open of the admin pages that show them. Demo-sized tables made that
 * invisible; a customer install after a year will not be. The default is far
 * above anything an admin table renders usefully, so no existing screen
 * changes; the max keeps a deliberate "give me everything" bounded too.
 */
import { z } from "zod";

export const LIST_DEFAULT_LIMIT = 1_000;
export const LIST_MAX_LIMIT = 5_000;

export const listLimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
});
