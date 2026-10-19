/**
 * Refusal codes a screen knows how to explain in its own words.
 *
 * The shared client already turns a refusal into a readable sentence, but a
 * handful of gateway codes arrive with no `detail` (`invalid_timezone`,
 * `approver_required`, …) and would otherwise read as the code humanised. A
 * screen passes the codes it can say better; every other refusal — including a
 * step-up or literacy refusal that carries its own guidance — is rethrown
 * unchanged so its structure survives.
 */
import { ApiError } from "../../../api/client";

export type RefusalSentences = Readonly<Record<string, string>>;

/** the sentence for a mapped refusal (plus the server's own detail), or null */
export function refusalSentence(err: unknown, sentences: RefusalSentences): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = typeof err.payload.error === "string" ? err.payload.error : null;
  if (!code || !(code in sentences)) return null;
  const raw = typeof err.payload.detail === "string" ? err.payload.detail.trim() : "";
  // the server's detail follows a full sentence, so it reads as one: capitalised and closed
  const detail = raw ? ` ${raw.charAt(0).toUpperCase()}${raw.slice(1)}${/[.!?]$/.test(raw) ? "" : "."}` : "";
  return `${sentences[code]}${detail}`;
}

/** run `fn`; a mapped refusal is rethrown as its sentence, anything else as it was */
export async function withRefusalCopy<T>(fn: () => Promise<T>, sentences: RefusalSentences): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const sentence = refusalSentence(err, sentences);
    if (sentence) throw new Error(sentence);
    throw err;
  }
}
