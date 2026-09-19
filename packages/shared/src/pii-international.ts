/**
 * International national-identifier detection (ADR-0117) — the checksum-first
 * extension to §8.4's `detectPII`.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `pii.ts` holds four live-verified,
 * load-bearing detectors whose behaviour is proven end-to-end against a real
 * provider. Nothing here may change any of them. Keeping the new work in its
 * own module makes that separation reviewable at a glance: `pii.ts` composes
 * this module's results in, and touches none of its own four.
 *
 * THE DESIGN RULE: VALIDATE, DO NOT PATTERN-MATCH.
 * In `block` mode a false positive REFUSES legitimate work, and the user has
 * no way to route around it. A miss is recoverable; a false refusal is not.
 * A bare "eleven digits" regex fires on order numbers, part numbers, epoch
 * timestamps and phone numbers, so every identifier here that carries a
 * published check digit is validated against it — the same bargain the
 * credit-card detector already strikes with Luhn. Identifiers with no check
 * digit are marked `checksum: false`, are held to the tightest structural
 * constraints their issuing authority publishes, and are OFF by default.
 *
 * CONTRACT. Same as `detectPII`: pure, total, no I/O, no LLM, and COUNTS ONLY
 * — a matched substring is never returned, never logged and never stored.
 */

/** A national-identifier category. One per jurisdiction+scheme, because a
 * deny reason that names `aadhaar` is more actionable than one that says
 * `national_id`, and naming the scheme is still counts-only/§8.4-safe. */
export type InternationalPiiCategory =
  | "aadhaar" // India — Unique Identification Authority of India number
  | "cpf" // Brazil — Cadastro de Pessoas Físicas
  | "bsn" // Netherlands — Burgerservicenummer
  | "sin" // Canada — Social Insurance Number
  | "tfn" // Australia — Tax File Number
  | "steuer_id" // Germany — steuerliche Identifikationsnummer (IdNr)
  | "nir" // France — INSEE/NIR (numéro de sécurité sociale)
  | "dni_nie" // Spain — DNI / NIE
  | "codice_fiscale" // Italy — Codice Fiscale
  | "nino"; // United Kingdom — National Insurance number

export interface InternationalDetector {
  readonly category: InternationalPiiCategory;
  /** ISO 3166-1 alpha-2 of the issuing jurisdiction. */
  readonly jurisdiction: string;
  /** True when a published check digit is verified before a match counts.
   * False means structure-only.
   *
   * THIS FIELD IS NOT A SAFETY RATING, and an earlier draft of this module
   * treated it as one. See `falsePositivePct`. */
  readonly checksum: boolean;
  /**
   * MEASURED percentage of uniformly-random strings of this scheme's own
   * shape that this detector accepts — its false-positive rate against
   * structureless input such as an order number, a part number or a
   * timestamp. Measured, not estimated; the method and the pinning test are
   * in `pii-conformance.test.ts`, and ADR-0117 records the date.
   *
   * A single decimal check digit can only ever divide by ten, so every
   * one-check-digit scheme here sits near 8-9%. That is the number that
   * decides whether a jurisdiction is safe to switch on for a given
   * deployment, and it is why NOTHING in this module is on by default.
   */
  readonly falsePositivePct: number;
  /** What this detector cannot do. Quoted into the guardrail registry so the
   * product's own limits page stays honest. */
  readonly limits: string;
  readonly count: (text: string) => number;
}

// ---------------------------------------------------------------------------
// Check-digit primitives
// ---------------------------------------------------------------------------

/** Verhoeff (dihedral group D5) — Aadhaar's check digit. Catches every single
 * digit error and every adjacent transposition, which a mod-10 sum does not. */
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * True when `digits` (pure digits, check digit included) passes Verhoeff.
 *
 * INDEXING, BECAUSE GETTING IT WRONG IS SILENT. `i` counts from 0 at the
 * RIGHTMOST digit (the check digit itself) and the permutation row is
 * `p[i % 8]`. The `p[(i + 1) % 8]` offset belongs to the GENERATION loop,
 * which runs over the payload WITHOUT its check digit; using it to validate
 * computes a different function that still accepts about one in ten random
 * inputs, so it looks like a working checksum and is not one. Anchored by the
 * published worked example payload 236 -> check digit 3, i.e. 2363 validates.
 */
function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (d < 0 || d > 9) return false;
    const row = VERHOEFF_P[i % 8];
    const dRow = VERHOEFF_D[c];
    if (!row || !dRow) return false;
    const p = row[d];
    if (p === undefined) return false;
    const next = dRow[p];
    if (next === undefined) return false;
    c = next;
  }
  return c === 0;
}

/** Luhn (mod-10). Duplicated rather than imported from `pii.ts` on purpose:
 * `pii.ts`'s copy is live-verified against the credit-card path and this
 * module must not be able to change it. Two callers, zero coupling. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** ISO 7064 MOD 11,10 — Germany's IdNr check digit. */
function mod11_10Valid(digits: string): boolean {
  let product = 10;
  for (let i = 0; i < digits.length - 1; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    let sum = (d + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

/** Digit at `i`, or -1. Keeps the checksum loops total under noUncheckedIndexedAccess. */
function at(s: string, i: number): number {
  const d = s.charCodeAt(i) - 48;
  return d >= 0 && d <= 9 ? d : -1;
}

/** True when every character of `s` is the same. Several schemes pass their
 * own checksum on a repdigit (CPF 111.111.111-11) but never issue one. */
function allSameDigit(s: string): boolean {
  const first = s[0];
  if (first === undefined) return false;
  for (let i = 1; i < s.length; i++) if (s[i] !== first) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-scheme validators
// ---------------------------------------------------------------------------

/** India, Aadhaar: 12 digits, Verhoeff, first digit 2-9 (0 and 1 are never
 * issued as the leading digit). */
function aadhaarValid(d: string): boolean {
  if (d.length !== 12) return false;
  const lead = at(d, 0);
  if (lead < 2) return false;
  if (allSameDigit(d)) return false;
  return verhoeffValid(d);
}

/** Brazil, CPF: 11 digits, two mod-11 check digits, repdigits excluded. */
function cpfValid(d: string): boolean {
  if (d.length !== 11 || allSameDigit(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += at(d, i) * (10 - i);
  const d1 = ((s * 10) % 11) % 10;
  if (d1 !== at(d, 9)) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += at(d, i) * (11 - i);
  const d2 = ((s * 10) % 11) % 10;
  return d2 === at(d, 10);
}

/** Netherlands, BSN: 9 digits, "11-proef" — 9·d1+8·d2+…+2·d8 −d9 ≡ 0 (mod 11).
 * All-zero is excluded (it passes the weighted sum but is never issued). */
function bsnValid(d: string): boolean {
  if (d.length !== 9 || allSameDigit(d)) return false;
  let s = 0;
  for (let i = 0; i < 8; i++) s += at(d, i) * (9 - i);
  s -= at(d, 8);
  return s % 11 === 0;
}

/** Canada, SIN: 9 digits, Luhn. Leading 0 and 8 are not assigned. */
function sinValid(d: string): boolean {
  if (d.length !== 9) return false;
  const lead = at(d, 0);
  if (lead === 0 || lead === 8) return false;
  if (allSameDigit(d)) return false;
  return luhnValid(d);
}

/** Australia, TFN: 9 digits, weighted sum ≡ 0 (mod 11). */
const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10] as const;
function tfnValid(d: string): boolean {
  if (d.length !== 9 || allSameDigit(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) {
    const w = TFN_WEIGHTS[i];
    if (w === undefined) return false;
    s += at(d, i) * w;
  }
  return s % 11 === 0;
}

/** Germany, IdNr: 11 digits, ISO 7064 MOD 11,10, first digit non-zero, AND the
 * BZSt uniqueness rule on the first ten — exactly one digit value repeats,
 * either twice or three times consecutively, every other value appearing once.
 * That rule is what separates an IdNr from an arbitrary 11-digit run, and it
 * is why this detector is safe to leave on by default. */
function steuerIdValid(d: string): boolean {
  if (d.length !== 11) return false;
  if (at(d, 0) === 0) return false;
  const head = d.slice(0, 10);
  const counts = new Map<string, number>();
  for (const ch of head) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const repeats = [...counts.entries()].filter(([, n]) => n > 1);
  if (repeats.length !== 1) return false;
  const entry = repeats[0];
  if (!entry) return false;
  const [value, n] = entry;
  if (n > 3) return false;
  // The published rule: where a digit occurs THREE times in the first ten, the
  // three occurrences must NOT stand in directly consecutive positions. So a
  // single adjacent pair among them disqualifies the number. (A digit
  // occurring exactly TWICE carries no adjacency constraint.)
  if (n === 3 && head.includes(value.repeat(2))) return false;
  return mod11_10Valid(d);
}

/** France, NIR: 13-digit body + 2-digit key, key = 97 − (body mod 97).
 * Sex digit 1/2 (or 7/8, temporary). Month 01-12, or the 20/30/40/50/62/63
 * codes used when the birth month is unknown. */
function nirValid(d: string): boolean {
  if (d.length !== 15) return false;
  const sex = at(d, 0);
  if (sex !== 1 && sex !== 2 && sex !== 7 && sex !== 8) return false;
  const month = at(d, 3) * 10 + at(d, 4);
  const monthOk =
    (month >= 1 && month <= 12) || month === 20 || month === 30 || month === 40 || month === 50 || month === 62 || month === 63;
  if (!monthOk) return false;
  const body = d.slice(0, 13);
  const key = d.slice(13);
  let rem = 0;
  for (let i = 0; i < 13; i++) rem = (rem * 10 + at(body, i)) % 97;
  // The key runs 01..97, NOT 00..96: it is 97 - (body mod 97), and a body that
  // is an exact multiple of 97 therefore carries the key 97. Reducing this
  // modulo 97 would both MISS every real NIR keyed 97 and ACCEPT a fabricated
  // one keyed 00 — roughly one NIR in ninety-seven, in both directions.
  const expected = 97 - rem;
  return expected === Number(key);
}

/** Spain, DNI (8 digits + letter) and NIE (X/Y/Z + 7 digits + letter):
 * letter = table[n mod 23]. */
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function dniLetterFor(n: number): string {
  return DNI_LETTERS.charAt(n % 23);
}

/** Italy, Codice Fiscale: 16 alphanumerics with a mod-26 check character over
 * odd/even position tables. */
const CF_ODD: Readonly<Record<string, number>> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
const CF_EVEN: Readonly<Record<string, number>> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12,
  N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
};
function codiceFiscaleValid(s: string): boolean {
  if (s.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = s.charAt(i);
    const v = i % 2 === 0 ? CF_ODD[c] : CF_EVEN[c];
    if (v === undefined) return false;
    sum += v;
  }
  return s.charAt(15) === "ABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(sum % 26);
}

/** United Kingdom, NINO — STRUCTURE ONLY, there is no check digit. HMRC's
 * published constraints are all we have: the two prefix letters exclude D, F,
 * I, Q, U and V entirely, exclude O in second position, and exclude the
 * reserved pairs BG/GB/NK/KN/TN/NT/ZZ; the suffix is A-D. That is roughly
 * 1 in 10^6 per random 2-letter+6-digit+letter string, which is a far weaker
 * guarantee than a check digit — hence opt-in. */
const NINO_INVALID_PREFIXES = new Set(["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]);

// ---------------------------------------------------------------------------
// Candidate scanning
// ---------------------------------------------------------------------------

/**
 * Count validated matches of a DIGIT-RUN scheme of exactly `len` digits.
 *
 * `sepClass` lets a scheme accept its own published print grouping (Aadhaar's
 * 4-4-4 spaces, CPF's 000.000.000-00) without opening the detector up to any
 * arbitrary punctuation. The run is anchored so that a longer digit sequence
 * can never yield a shorter "match" out of its middle — a 16-digit card must
 * not read as a 12-digit Aadhaar.
 */
function countDigitScheme(
  text: string,
  len: number,
  sepClass: string,
  validate: (digits: string) => boolean,
): number {
  const sep = sepClass ? `[${sepClass}]?` : "";
  const re = new RegExp(`(?<![0-9])(?:[0-9]${sep}){${len - 1}}[0-9](?![0-9])`, "g");
  const sepSet = new Set(sepClass.split(""));
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // The bare `(?<![0-9])`/`(?![0-9])` anchors stop a LONGER BARE digit run
    // from yielding a shorter scheme out of its middle, but they are satisfied
    // by the scheme's OWN separator — so `4111 1111 1111 1111`, a space-grouped
    // 16-digit card, offers its first twelve digits as an Aadhaar candidate and
    // only the check digit stands between that and a refusal. Extend the anchor
    // by one character in each direction: a separator that is itself adjacent to
    // a digit means the run CONTINUES, and this is a slice of something longer.
    const start = m.index;
    const end = m.index + m[0].length;
    if (sepSet.has(text[start - 1] ?? "") && isDigit(text[start - 2])) continue;
    if (sepSet.has(text[end] ?? "") && isDigit(text[end + 1])) continue;
    const digits = m[0].replace(/[^0-9]/g, "");
    if (digits.length === len && validate(digits)) n++;
  }
  return n;
}

function countAadhaar(text: string): number {
  return countDigitScheme(text, 12, " -", aadhaarValid);
}
function countCpf(text: string): number {
  return countDigitScheme(text, 11, ".-", cpfValid);
}
function countBsn(text: string): number {
  return countDigitScheme(text, 9, ".", bsnValid);
}
function countSin(text: string): number {
  return countDigitScheme(text, 9, " -", sinValid);
}
function countTfn(text: string): number {
  return countDigitScheme(text, 9, " ", tfnValid);
}
function countSteuerId(text: string): number {
  return countDigitScheme(text, 11, " ", steuerIdValid);
}
function countNir(text: string): number {
  return countDigitScheme(text, 15, " ", nirValid);
}

const DNI_RE = /(?<![A-Za-z0-9])([XYZ]?)(\d{7,8})[ -]?([A-Za-z])(?![A-Za-z0-9])/g;
function countDniNie(text: string): number {
  let n = 0;
  DNI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DNI_RE.exec(text)) !== null) {
    const prefix = (m[1] ?? "").toUpperCase();
    const digits = m[2] ?? "";
    const letter = (m[3] ?? "").toUpperCase();
    if (prefix === "") {
      // DNI: exactly 8 digits.
      if (digits.length !== 8) continue;
      if (dniLetterFor(Number(digits)) === letter) n++;
    } else {
      // NIE: X/Y/Z + exactly 7 digits, prefix folded to 0/1/2.
      if (digits.length !== 7) continue;
      const fold = prefix === "X" ? "0" : prefix === "Y" ? "1" : "2";
      if (dniLetterFor(Number(fold + digits)) === letter) n++;
    }
  }
  return n;
}

const CF_RE = /(?<![A-Za-z0-9])[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z](?![A-Za-z0-9])/g;
function countCodiceFiscale(text: string): number {
  let n = 0;
  CF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CF_RE.exec(text)) !== null) {
    if (codiceFiscaleValid(m[0].toUpperCase())) n++;
  }
  return n;
}

const NINO_RE = /(?<![A-Za-z0-9])([A-Za-z]{2})[ ]?(\d{2})[ ]?(\d{2})[ ]?(\d{2})[ ]?([A-Da-d])(?![A-Za-z0-9])/g;
function countNino(text: string): number {
  let n = 0;
  NINO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NINO_RE.exec(text)) !== null) {
    const prefix = (m[1] ?? "").toUpperCase();
    const a = prefix.charAt(0);
    const b = prefix.charAt(1);
    if ("DFIQUV".includes(a)) continue;
    if ("DFIQUVO".includes(b)) continue;
    if (NINO_INVALID_PREFIXES.has(prefix)) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every international detector, in a stable order. `checksum: true` members
 * are the DEFAULT-ON set (see `DEFAULT_INTERNATIONAL_CATEGORIES`); the
 * structure-only members are opt-in.
 */
export const INTERNATIONAL_DETECTORS: readonly InternationalDetector[] = [
  {
    category: "aadhaar",
    jurisdiction: "IN",
    checksum: true,
    falsePositivePct: 8.03,
    limits: "Verhoeff-validated 12-digit runs, optionally 4-4-4 spaced or hyphenated. Does not read a VID or an Aadhaar masked to its last four digits.",
    count: countAadhaar,
  },
  {
    category: "cpf",
    jurisdiction: "BR",
    checksum: true,
    falsePositivePct: 1.02,
    limits: "Two mod-11 check digits over 11 digits, bare or 000.000.000-00 formatted. Repdigits excluded. Does not cover CNPJ (a company, not a person).",
    count: countCpf,
  },
  {
    category: "bsn",
    jurisdiction: "NL",
    checksum: true,
    falsePositivePct: 9.03,
    limits: "11-proef over exactly 9 digits. A BSN written with its leading zero dropped (8 digits) is NOT detected — it is indistinguishable from any 8-digit number.",
    count: countBsn,
  },
  {
    category: "sin",
    jurisdiction: "CA",
    checksum: true,
    falsePositivePct: 8.09,
    limits: "Luhn over 9 digits, leading 0/8 excluded. Luhn is a weaker guarantee than mod-11: roughly 1 in 10 random 9-digit runs pass it, so the leading-digit rule is doing real work here.",
    count: countSin,
  },
  {
    category: "tfn",
    jurisdiction: "AU",
    checksum: true,
    falsePositivePct: 9.00,
    limits: "Weighted mod-11 over 9 digits. The legacy 8-digit TFN is NOT detected — accepting 8 digits would collide with too many order numbers.",
    count: countTfn,
  },
  {
    category: "steuer_id",
    jurisdiction: "DE",
    checksum: true,
    falsePositivePct: 0.23,
    limits: "ISO 7064 MOD 11,10 plus the BZSt repeated-digit rule over 11 digits. Does not cover the Steuernummer (a per-Land tax file reference, not a personal identifier).",
    count: countSteuerId,
  },
  {
    category: "nir",
    jurisdiction: "FR",
    checksum: true,
    falsePositivePct: 0.06,
    limits: "mod-97 key over a 15-digit NIR. Corsica's 2A/2B department codes are NOT detected — those carry letters the numeric key rule cannot consume.",
    count: countNir,
  },
  {
    category: "dni_nie",
    jurisdiction: "ES",
    checksum: true,
    falsePositivePct: 3.87,
    limits: "mod-23 check letter over a DNI (8 digits) or NIE (X/Y/Z + 7 digits). A DNI written without its letter is NOT detected — there is nothing left to validate.",
    count: countDniNie,
  },
  {
    category: "codice_fiscale",
    jurisdiction: "IT",
    checksum: true,
    falsePositivePct: 3.87,
    limits: "mod-26 check character over the 16-character personal form. The omocodia variant (digits substituted by letters to break a collision) is NOT detected.",
    count: countCodiceFiscale,
  },
  {
    category: "nino",
    jurisdiction: "GB",
    checksum: false,
    falsePositivePct: 8.47,
    limits: "STRUCTURE ONLY — a NINO has no check digit. Prefix/suffix exclusions only, so the false-positive risk is materially higher than every checksum scheme above. Opt-in for that reason.",
    count: countNino,
  },
];

/**
 * The categories enabled when a deployment expresses no preference: NONE.
 *
 * An earlier draft of this module defaulted to "every checksum-backed
 * category", on the reasoning that a verified check digit is enough to make a
 * detector safe to leave on. MEASUREMENT KILLED THAT REASONING. A single
 * decimal check digit divides the candidate space by ten and no more, so the
 * Dutch BSN accepts 9.03% of random 9-digit runs, the Australian TFN 9.00%, the
 * Canadian SIN 8.09% and Aadhaar 8.03% — roughly one bare order number in
 * eleven. Only the multi-digit and structurally-constrained schemes (CPF 1.02%,
 * German IdNr 0.23%, French NIR 0.06%) are cheap to switch on blind.
 *
 * Those rates are per-jurisdiction facts, not a product-wide one, so the
 * product may not pick for the customer: a German deployment switching on
 * Brazilian CPF buys false refusals it has no use for, and a Dutch one
 * switching on BSN is knowingly accepting a 9% rate on bare 9-digit runs in
 * exchange for catching the real thing. The admin chooses, per jurisdiction,
 * with `falsePositivePct` on the screen next to the switch.
 *
 * It is also the UPGRADE posture, and that is not negotiable here: an install
 * that upgrades into this code detects EXACTLY what it detected before, and no
 * prompt that was allowed yesterday is refused today until an administrator
 * acts. See ADR-0117.
 */
export const DEFAULT_INTERNATIONAL_CATEGORIES: readonly InternationalPiiCategory[] = [];

/** Every category this module can detect, default-on or not. */
export const ALL_INTERNATIONAL_CATEGORIES: readonly InternationalPiiCategory[] =
  INTERNATIONAL_DETECTORS.map((d) => d.category);
