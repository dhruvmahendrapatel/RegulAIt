/**
 * Batch U4 — the refusal of a one-record read, in words.
 *
 * Every detail dialog this batch added (a receipt, an import batch, a training
 * job, a rate card, a statement, a report definition or run, an initiative, a
 * prompt commit, a red-team run's trials) reads ONE record. Its refusals are the
 * same few shapes: the record is not there (404), the reference is malformed
 * (400, zod or the route's own `invalid_*`), the caller is not entitled to it
 * (403), or the server failed. The route's own code is mapped to a sentence the
 * caller passes in (`known`); anything else falls back to the shared client's
 * readable message. Only a server or network failure offers Retry: retrying a
 * 404 or a 403 cannot change the answer.
 */

export interface RefusalWords {
  title: string;
  body: string;
  /** whether retrying could change the answer */
  retry: boolean;
}

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  payload?: { error?: unknown } | null;
}

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? "an" : "a");

/** the refusal of a one-record read as a title, a sentence and whether Retry helps */
export function refusalWords(noun: string, error: unknown, known: Readonly<Record<string, string>> = {}): RefusalWords {
  const e = (error ?? {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : null;
  const code = typeof e.payload?.error === "string" ? e.payload.error : null;
  const message = typeof e.message === "string" && e.message ? e.message : "Something went wrong — try again.";
  const title =
    status === 403
      ? `You don't have access to this ${noun}`
      : status === 404
        ? `No such ${noun}`
        : status === 400
          ? `This is not ${article(noun)} ${noun} reference`
          : `Couldn't load this ${noun}`;
  const retry = status === null || status >= 500 || status === 429;
  if (code && known[code]) return { title, body: known[code]!, retry };
  if (status === 404) return { title, body: `There is no ${noun} with this ID — it may have been removed, or the link may be wrong.`, retry };
  if (status === 400) return { title, body: `The ${noun} ID is malformed, so nothing was looked up. ${message}`, retry };
  return { title, body: message, retry };
}
