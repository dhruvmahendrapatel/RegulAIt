/**
 * ADR-0060 — the tamper-evident `audit_log` hash chain, PURE half.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS PURE
 * ----------------------------------------------
 * Two completely different pieces of the system have to agree, byte for byte,
 * on what "the bytes of this audit row" means:
 *
 *   * the WRITER (`@regulait/db`'s chained insert) hashes a row it is about to
 *     store, from a JavaScript object the caller handed it;
 *   * the VERIFIER (`GET /v1/audit/verify`) hashes the SAME row after it has
 *     been through Postgres and come back out.
 *
 * If those two ever disagree by one byte, verification reports tampering on
 * data nobody touched. ADR-0060's Consequences section names this as "the thing
 * most likely to bite the implementation", so the serialization lives here, on
 * its own, as a pure function with no database, no clock and no I/O — testable
 * in isolation, and impossible for either side to "improve" independently.
 *
 * THE TRAP, STATED PLAINLY
 * ------------------------
 * `detail` and `rule_chain` are `jsonb`. Postgres `jsonb` is NOT a byte store:
 * it parses the JSON, throws the original text away, and re-emits it later in
 * its own key order (by key length, then bytewise — not insertion order, not
 * lexicographic). So `{"b":1,"a":2}` goes in and `{"a": 2, "b": 1}` comes out.
 * Hashing `JSON.stringify(value)` on the way in and `JSON.stringify(value)` on
 * the way out therefore produces two different hashes for the same data, and
 * every single row would report as tampered.
 *
 * The fix is not to try to predict Postgres's ordering — that would couple our
 * hash to a storage-engine implementation detail. It is to RECURSIVELY SORT
 * KEYS ourselves, so key order is not an input to the hash at all. Whatever
 * order Postgres hands the object back in, we re-sort it and get the same
 * string.
 *
 * THE RULES THIS FILE PINS (ADR-0060's "pin the canonicalization precisely")
 * -------------------------------------------------------------------------
 *  1. OBJECT KEYS are sorted ascending by UTF-16 code unit (`Array#sort`'s
 *     default on strings). Recursively, at every depth.
 *  2. ARRAY ORDER IS DATA and is never sorted. Reordering an array IS a change.
 *  3. NO INSIGNIFICANT WHITESPACE. Compact form, `{"a":1,"b":[2,3]}`.
 *  4. `undefined` as an OBJECT VALUE means "absent": the key is dropped,
 *     exactly as `JSON.stringify` does and exactly as `jsonb` will store it.
 *     `{"a":undefined}` and `{}` therefore hash identically — they have to,
 *     because Postgres cannot tell them apart either.
 *  5. `undefined` as an ARRAY ELEMENT becomes `null` (again matching
 *     `JSON.stringify`, and again matching what `jsonb` will store).
 *  6. `null` is preserved and is NOT the same as absent (rule 4). A row with
 *     `{"a":null}` hashes differently from one with `{}` — that distinction
 *     survives `jsonb`, so the hash must respect it.
 *  7. NUMBERS are emitted by `JSON.stringify`'s number rule, which is the
 *     shortest round-trippable decimal for the double. This is what makes the
 *     Postgres round trip safe: `numeric` is an exact decimal type, so the
 *     shortest repr of a double goes in exactly and parses back to the SAME
 *     double, whatever textual form Postgres chooses to echo. Consequences:
 *       - `-0` serializes as `0`. IEEE-754 keeps the sign; JSON does not; and
 *         `jsonb` does not either. Pretending otherwise would be a hash that
 *         disagrees with storage.
 *       - `NaN` / `±Infinity` serialize as `null`, because that is what
 *         `JSON.stringify` sends to the driver, so `null` is what is actually
 *         stored. Hashing them as anything else would hash a value that does
 *         not exist in the database.
 *       - `1` and `1.0` are the same double and hash identically. They are the
 *         same number; JavaScript has no way to tell them apart.
 *  8. STRINGS are emitted by `JSON.stringify`'s string rule: quotes,
 *     backslashes and control characters escaped, and everything else — every
 *     non-ASCII code point — left LITERAL and hashed as UTF-8. No `\uXXXX`
 *     escaping of ordinary text, so "é", "日本", "🙂" hash as their own bytes
 *     and survive the UTF-8 round trip through Postgres unchanged.
 *  9. `Date` (and anything else carrying `toJSON`) is converted via `toJSON()`
 *     first, then canonicalized — so a `Date` nested in `detail` hashes as the
 *     ISO string that `jsonb` will actually contain.
 * 10. `bigint`, functions and symbols THROW rather than being silently coerced.
 *     A value that cannot survive the JSON round trip must not be hashed as if
 *     it had.
 *
 * WHAT IS DELIBERATELY NOT HERE: any hashing of the chain's *position*
 * (`seq`, `prev_hash`, `row_hash`). Those are the chain's own bookkeeping and
 * are assigned by the writer under a lock; `content_hash` covers the row's
 * IMMUTABLE FACTS only, which is what makes "this row's content was edited"
 * distinguishable from "this row was moved".
 */
import { createHash } from "node:crypto";

/** The one hash function v1 uses. ADR-0060's hash-agility note: it is not
 * stored per row, so a future rollover re-chains from a NEW genesis rather
 * than reinterpreting these rows. */
export const AUDIT_CHAIN_ALGORITHM = "sha256" as const;

/** Version tag prefixed onto every canonical payload. If the field set or the
 * serialization rules ever change, this string changes with them, and old rows
 * stay verifiable under the old rules instead of silently going "tampered". */
export const AUDIT_PAYLOAD_VERSION = "regulait.audit.v1" as const;

/** `prev_hash` of the genesis row. 64 zeros — the chain has no predecessor. */
export const AUDIT_GENESIS_PREV_HASH = "0".repeat(64);

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The canonical, deterministic JSON serialization described above.
 *
 * Pure: same input, same string, forever, on any platform, in any key order.
 */
export function canonicalJson(value: unknown): string {
  return writeValue(value);
}

function writeValue(value: unknown): string {
  // rule 9 — honour toJSON before anything else, exactly like JSON.stringify
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return writeValue((value as { toJSON: () => unknown }).toJSON());
  }
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // rule 7 — JSON.stringify's number rule, including -0 -> 0 and
      // non-finite -> null, because that is what actually reaches Postgres.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      // rule 8 — JSON.stringify's string rule; non-ASCII stays literal.
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: bigint cannot be canonicalized (it does not survive JSON/jsonb)");
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} cannot be canonicalized`);
    case "undefined":
      // Only reachable for a TOP-LEVEL undefined; object/array members are
      // handled by their own rules below.
      return "null";
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    // rule 2 + rule 5 — order preserved; undefined, functions, symbols AND
    // sparse holes all become null. An index loop, not `.map`, because `.map`
    // skips holes and would emit `[1,,3]`, which is not even valid JSON.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const el = value[i];
      parts.push(el === undefined || typeof el === "function" || typeof el === "symbol" ? "null" : writeValue(el));
    }
    return `[${parts.join(",")}]`;
  }

  // rule 1 + rule 3 + rule 4
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => {
      const v = obj[k];
      return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
    })
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${writeValue(obj[k])}`).join(",")}}`;
}

/**
 * The IMMUTABLE FACTS of an audit row — exactly the field list ADR-0060 §1
 * names, and nothing else.
 *
 * `at` is accepted as a `Date` or an ISO string because the writer holds a
 * `Date` and the verifier gets a `Date` back from the driver, while a hand-
 * written fixture may hold a string; both normalize to the same ISO-8601
 * millisecond form below.
 */
export interface AuditChainFields {
  id: string;
  at: Date | string;
  userId: string;
  objectType: string;
  objectId?: string | null | undefined;
  detail?: unknown;
  serverId?: string | null | undefined;
  toolName?: string | null | undefined;
  effect: string;
  ruleId: string;
  ruleChain: unknown;
  reason: string;
  deployMode?: string | null | undefined;
  /** ADR-0188 decision 19: the canonical serialisation the row was written
   * under (NULL on every v1 row), and the three actor fields v2 covers. A v1
   * row's hash does not cover any of these four. */
  chainVersion?: number | null | undefined;
  actorIdentityId?: string | null | undefined;
  delegationGrantId?: string | null | undefined;
  actorChain?: unknown;
}

/**
 * Normalize `at` to ISO-8601 with millisecond precision and a literal `Z`.
 *
 * Millisecond precision is not a rounding convenience — it is the resolution
 * JavaScript's `Date` actually has. The writer always supplies `at` explicitly
 * (it never lets the column default fire) precisely so the value that is
 * hashed and the value that is stored are the same instant at the same
 * resolution, and a microsecond the writer never knew about can never appear
 * in the column and break the hash on read-back.
 */
function normalizeAt(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new TypeError(`canonicalAuditPayload: invalid 'at' value: ${String(at)}`);
  return new Date(ms).toISOString();
}

/** `null` and `undefined` both mean "this column is NULL" — Postgres cannot
 * tell them apart, so neither can the hash. */
function nullable(v: string | null | undefined): string | null {
  return v === undefined ? null : v;
}

/**
 * The exact bytes that `content_hash` is taken over.
 *
 * Shape: `"<version>\n<canonical json of the field map>"`. The version prefix
 * is inside the hash, so a payload hashed under v1 rules can never be
 * mistaken for the same bytes under a future v2.
 */
export function canonicalAuditPayload(row: AuditChainFields): string {
  return `${AUDIT_PAYLOAD_VERSION}\n${canonicalJson({
    id: row.id,
    at: normalizeAt(row.at),
    userId: row.userId,
    objectType: row.objectType,
    objectId: nullable(row.objectId),
    detail: row.detail === undefined ? null : row.detail,
    serverId: nullable(row.serverId),
    toolName: nullable(row.toolName),
    effect: row.effect,
    ruleId: row.ruleId,
    ruleChain: row.ruleChain === undefined ? null : row.ruleChain,
    reason: row.reason,
    deployMode: nullable(row.deployMode),
  })}`;
}

/** `content_hash` — SHA-256 over this row's immutable facts alone. */
export function auditContentHash(row: AuditChainFields): string {
  return sha256Hex(canonicalAuditPayload(row));
}

// --- ADR-0188 decision 19: canonical serialisation version 2 -----------------
//
// v2 adds the actor fields (who an agent action was FOR is `userId`, the
// sponsor; who DID it is the actor identity, the delegation grant and the
// ordered chain) INSIDE `content_hash`, plus the version itself, so a v2 row
// that is re-hashed as v1, or whose version is edited, no longer verifies.
// Null-valued fields are serialised explicitly, never omitted. v1 hashes are
// never recomputed: rows below the boundary (`audit_chain_versions.from_seq`,
// set under the append lock by the cutover, S4) stay v1 forever.

/** Version tag of the v2 canonical payload. */
export const AUDIT_PAYLOAD_VERSION_V2 = "regulait.audit.v2" as const;
/** The canonical serialisation versions this build reads and writes. */
export type AuditChainVersion = 1 | 2;

/** The v2 canonical payload: every v1 fact, `chainVersion: 2`, and the three actor fields. */
export function canonicalAuditPayloadV2(row: AuditChainFields): string {
  return `${AUDIT_PAYLOAD_VERSION_V2}\n${canonicalJson({
    id: row.id,
    at: normalizeAt(row.at),
    userId: row.userId,
    objectType: row.objectType,
    objectId: nullable(row.objectId),
    detail: row.detail === undefined ? null : row.detail,
    serverId: nullable(row.serverId),
    toolName: nullable(row.toolName),
    effect: row.effect,
    ruleId: row.ruleId,
    ruleChain: row.ruleChain === undefined ? null : row.ruleChain,
    reason: row.reason,
    deployMode: nullable(row.deployMode),
    // the version is part of the hashed data: a v2 row claiming anything else does not hash to itself
    chainVersion: 2,
    actorIdentityId: nullable(row.actorIdentityId),
    delegationGrantId: nullable(row.delegationGrantId),
    actorChain: row.actorChain === undefined ? null : row.actorChain,
  })}`;
}

/** `content_hash` under an explicit serialisation version. */
export function auditContentHashFor(row: AuditChainFields, version: AuditChainVersion): string {
  return sha256Hex(version === 2 ? canonicalAuditPayloadV2(row) : canonicalAuditPayload(row));
}

/** Which version a row at `seq` must be hashed under, given the recorded v2 boundary (null = none yet). */
export function auditChainVersionAt(seq: number, v2FromSeq: number | null | undefined): AuditChainVersion {
  return v2FromSeq != null && seq >= v2FromSeq ? 2 : 1;
}

/** One row of `audit_chain_versions`, as stored. */
export interface AuditChainBoundaryRecord {
  version: number;
  fromSeq: number;
}

/**
 * What the recorded boundaries mean to this build (ADR-0188 decision 19; X35
 * I7S-02). The ONE interpretation the writer, the verifier and the receipt
 * sweep share: `v2FromSeq` when every recorded boundary is one this build can
 * write and verify, or the first boundary it cannot. An unknown version fails
 * closed everywhere: the writer refuses to append, the verifier reports a
 * break, the receipt sweep signs nothing.
 */
export type AuditChainBoundary =
  | { supported: true; v2FromSeq: number | null }
  | { supported: false; version: number; fromSeq: number; detail: string };

/** The boundary versions this build knows (v1 has no boundary row: it is everything before the first one). */
export const AUDIT_CHAIN_BOUNDARY_VERSIONS: ReadonlyArray<number> = [2];

export function resolveAuditChainBoundary(records: ReadonlyArray<AuditChainBoundaryRecord>): AuditChainBoundary {
  const sorted = records
    .map((r) => ({ version: Number(r.version), fromSeq: Number(r.fromSeq) }))
    .sort((a, b) => a.fromSeq - b.fromSeq);
  const unknown = sorted.find((r) => !AUDIT_CHAIN_BOUNDARY_VERSIONS.includes(r.version));
  if (unknown) {
    return {
      supported: false,
      version: unknown.version,
      fromSeq: unknown.fromSeq,
      detail: `the chain records serialisation version ${unknown.version} from seq ${unknown.fromSeq}, which this build can neither write nor verify`,
    };
  }
  return { supported: true, v2FromSeq: sorted.find((r) => r.version === 2)?.fromSeq ?? null };
}

/**
 * The per-row version checks every reader of the chain applies before it trusts
 * a row's hash (verifier and receipt sweep alike):
 *  - `version_mismatch`: the row's stored version is not the one the boundary
 *    requires at its `seq`;
 *  - `actor_on_v1` (X35 I7S-01): a v1 row carries actor attribution. A v1 hash
 *    does not cover the actor columns and the writer never sets them below the
 *    boundary, so any value there was written around the chain (a raw UPDATE),
 *    and the row's hash cannot vouch for it. v1 hashes are unchanged by this check.
 */
export function auditRowVersionProblem(
  row: Pick<ChainedAuditRow, "seq" | "chainVersion" | "actorIdentityId" | "delegationGrantId" | "actorChain">,
  v2FromSeq: number | null,
): Omit<ChainBreak, "seq"> | null {
  const version = auditChainVersionAt(row.seq, v2FromSeq);
  const stored = row.chainVersion ?? null;
  if (version === 2 ? stored !== 2 : stored !== null) {
    return {
      kind: "version_mismatch",
      expected: version === 2 ? "2" : "null",
      actual: stored === null ? "null" : String(stored),
      detail:
        version === 2
          ? "this row is at or past the recorded v2 boundary but does not carry chain version 2"
          : "this row is before any recorded v2 boundary but claims a chain version",
    };
  }
  if (version === 1) {
    const fields: Array<[string, unknown]> = [
      ["actor_identity_id", row.actorIdentityId],
      ["delegation_grant_id", row.delegationGrantId],
      ["actor_chain", row.actorChain],
    ];
    const set = fields.filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
    if (set.length > 0) {
      return {
        kind: "actor_on_v1",
        expected: "no actor fields on a v1 row",
        actual: set.join(","),
        detail:
          "this v1 row carries actor attribution its hash does not cover; the writer never sets it before the v2 boundary, so it was written around the chain",
      };
    }
  }
  return null;
}

/**
 * `row_hash = SHA-256(prev_hash || content_hash)` — the LINKED value.
 *
 * DELIBERATE DEVIATION FROM ADR-0060 §1's PARENTHETICAL, and why.
 * ---------------------------------------------------------------
 * §1 says in passing that `prev_hash` is "the `content_hash` of the
 * immediately preceding row". Taken literally that yields a chain of ADJACENT
 * PAIRS rather than an accumulator: `row_hash[n]` would depend only on rows
 * n-1 and n, so the chain HEAD would commit to the last two rows and nothing
 * else. An adversary who edited row 5 and recomputed everything downstream
 * would land on a head IDENTICAL to the anchored one — and the anchor, which
 * the same ADR's threat model and worked example make the load-bearing control
 * against exactly that adversary, would catch nothing.
 *
 * The ADR's own worked example requires the opposite: "the recomputed head no
 * longer matches the head that was anchored to Object-Lock S3 before the edit."
 * That is only true if `row_hash` accumulates the whole history. So `prev_hash`
 * is the PRECEDING ROW'S `row_hash`, making the head a commitment to every row
 * from genesis onward. The formula ADR-0060 actually writes down —
 * `SHA-256(prev_hash || content_hash)` — is unchanged.
 */
export function auditRowHash(prevHash: string, contentHash: string): string {
  return sha256Hex(`${prevHash}${contentHash}`);
}

// --- the genesis row ---------------------------------------------------------
//
// ADR-0060 §2. Rows written before this migration CANNOT be retroactively
// chained: doing so would mean rewriting every one of them, which is
// indistinguishable from the tampering this whole ADR exists to detect. So the
// chain does not pretend to cover them. It starts at a genesis row that says
// so, in the record itself, in words an auditor reading the raw table can see.
//
// The genesis row is deliberately IDENTICAL ON EVERY INSTALL — fixed id, fixed
// timestamp, fixed detail, no install-specific counts. That makes its
// `content_hash` and `row_hash` COMPILE-TIME CONSTANTS: they are asserted in
// this package's tests, hardcoded in migration 0067, and an auditor can
// recompute them from this file alone without access to any deployment. The
// number of un-chained legacy rows is NOT baked into the row (it would vary per
// install and destroy that property); `GET /v1/audit/verify` counts it live and
// reports it instead.

/** `object_type` of the genesis row and of nothing else. */
export const AUDIT_GENESIS_OBJECT_TYPE = "audit_chain" as const;
/** `rule_id` of the genesis row. */
export const AUDIT_GENESIS_RULE_ID = "audit-chain-genesis" as const;
/** The genesis row is always the first chained row. */
export const AUDIT_GENESIS_SEQ = 1;

/** The disclosure sentence, kept in ONE place so the row, the migration and
 * the verify response cannot drift into three different promises. */
export const AUDIT_LEGACY_DISCLOSURE =
  "Rows written before the genesis row are un-chained legacy: they carry no seq and no hashes, " +
  "the integrity guarantee does not cover them, and they are protected only by ADR-0035 backups. " +
  "Chaining them retroactively would require rewriting them, which is indistinguishable from tampering.";

/** The exact field values of the genesis row, frozen. */
export const AUDIT_GENESIS_ROW: AuditChainFields = Object.freeze({
  id: "00000000-0000-0000-0000-000000000060",
  at: "2026-08-01T00:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000000",
  objectType: AUDIT_GENESIS_OBJECT_TYPE,
  objectId: null,
  detail: Object.freeze({
    adr: "ADR-0060",
    algorithm: AUDIT_CHAIN_ALGORITHM,
    boundary: "genesis",
    guaranteeStartsAtSeq: AUDIT_GENESIS_SEQ,
    legacyRowsAreUnchained: true,
    legacyProtection: "ADR-0035 backups only — not tamper-evident",
    payloadVersion: AUDIT_PAYLOAD_VERSION,
  }),
  serverId: null,
  toolName: null,
  effect: "allow",
  ruleId: AUDIT_GENESIS_RULE_ID,
  ruleChain: Object.freeze([AUDIT_GENESIS_RULE_ID]),
  reason:
    "audit-chain genesis: the tamper-evident hash chain starts here. " +
    "Every audit_log row written before this one is un-chained legacy and is NOT covered by it.",
  deployMode: null,
}) as AuditChainFields;

/** `content_hash` of the genesis row — the same 64 hex characters on every
 * install of this product. Hardcoded in migration 0067; asserted in tests. */
export const AUDIT_GENESIS_CONTENT_HASH = auditContentHash(AUDIT_GENESIS_ROW);

/** `row_hash` of the genesis row: `SHA-256(64 zeros || content_hash)`. */
export const AUDIT_GENESIS_ROW_HASH = auditRowHash(AUDIT_GENESIS_PREV_HASH, AUDIT_GENESIS_CONTENT_HASH);

// --- verification, as a pure function ----------------------------------------

/** One row as verification sees it: the immutable facts PLUS the chain
 * bookkeeping that was stored alongside them. */
export interface ChainedAuditRow extends AuditChainFields {
  seq: number;
  contentHash: string | null;
  prevHash: string | null;
  rowHash: string | null;
}

export type ChainBreakKind =
  /** `seq` is not exactly one more than the previous row's — a row is gone, or
   * a `seq` was rewritten. */
  | "sequence_gap"
  /** `prev_hash` does not name the previous row's `row_hash` — the row was
   * moved, or its predecessor was replaced. */
  | "linkage_mismatch"
  /** the row's own fields no longer hash to its stored `content_hash` — the
   * content was edited in place. */
  | "content_mismatch"
  /** content and linkage both check out but `row_hash` does not follow from
   * them — the stored linked value was edited directly. */
  | "row_hash_mismatch"
  /** a chained row is missing one of the three hash columns entirely. */
  | "missing_hash"
  /** ADR-0188 decision 19: the row's stored serialisation version is not the
   * one the recorded boundary requires at its `seq` (a v2 row claiming v1 or no
   * version, or a v1 row claiming v2). */
  | "version_mismatch"
  /** X35 I7S-01: a v1 row (before the recorded v2 boundary) carries an actor
   * field its v1 hash does not cover, so the attribution was added around the chain. */
  | "actor_on_v1"
  /** X35 I7S-02: `audit_chain_versions` records a serialisation version this
   * build does not know; rows from that boundary on cannot be verified, so the
   * chain is reported broken there rather than passed. */
  | "unsupported_chain_version";

export interface ChainBreak {
  seq: number;
  kind: ChainBreakKind;
  expected: string | null;
  actual: string | null;
  detail: string;
}

/**
 * Walk a batch of rows in `seq` order and return the FIRST break, or `null`.
 *
 * `expectedSeq` / `prevRowHash` carry the walk's state across batches, so the
 * caller can stream the log in keyset pages (ADR-0031) and never hold more
 * than one page in memory. That is the whole reason this is shaped as a
 * resumable step function rather than "give me the table".
 */
export function verifyChainBatch(
  rows: ChainedAuditRow[],
  state: {
    expectedSeq: number;
    prevRowHash: string;
    /** ADR-0188 decision 19: the first `seq` written as v2, read from the
     * verifier-trusted `audit_chain_versions` table (never inferred from a row
     * flag). Absent or null: every row is v1. */
    v2FromSeq?: number | null;
  },
): { break: ChainBreak | null; expectedSeq: number; prevRowHash: string } {
  let { expectedSeq, prevRowHash } = state;
  const v2FromSeq = state.v2FromSeq ?? null;

  for (const row of rows) {
    if (row.contentHash === null || row.prevHash === null || row.rowHash === null) {
      return {
        break: {
          seq: row.seq,
          kind: "missing_hash",
          expected: "three non-null hash columns",
          actual: `content=${row.contentHash} prev=${row.prevHash} row=${row.rowHash}`,
          detail: "a row inside the chained range carries no hashes; it was inserted around the chaining path",
        },
        expectedSeq,
        prevRowHash,
      };
    }

    // 1. ORDER. A deletion shows up here first: the survivor's seq is too big.
    if (row.seq !== expectedSeq) {
      return {
        break: {
          seq: row.seq,
          kind: "sequence_gap",
          expected: String(expectedSeq),
          actual: String(row.seq),
          detail:
            row.seq > expectedSeq
              ? `seq ${expectedSeq}${row.seq - expectedSeq > 1 ? `..${row.seq - 1}` : ""} is missing — ${row.seq - expectedSeq} row(s) deleted or renumbered`
              : `seq went backwards — rows were renumbered`,
        },
        expectedSeq,
        prevRowHash,
      };
    }

    // 2. LINKAGE. Reordering and predecessor-replacement land here.
    if (row.prevHash !== prevRowHash) {
      return {
        break: {
          seq: row.seq,
          kind: "linkage_mismatch",
          expected: prevRowHash,
          actual: row.prevHash,
          detail: "this row's prev_hash does not name the preceding row's row_hash — a row was moved, replaced or removed",
        },
        expectedSeq,
        prevRowHash,
      };
    }

    // 3. CONTENT. An in-place UPDATE of reason/detail/effect lands here, at
    //    exactly the seq that was edited.
    // 3a. VERSION (ADR-0188 decision 19): the boundary decides, and the row's
    //     own stored version must agree with it — v2 rows carry 2, v1 rows none,
    //     and a v1 row carries no actor fields (X35 I7S-01).
    const problem = auditRowVersionProblem(row, v2FromSeq);
    if (problem) {
      return { break: { seq: row.seq, ...problem }, expectedSeq, prevRowHash };
    }
    const version = auditChainVersionAt(row.seq, v2FromSeq);
    const recomputedContent = auditContentHashFor(row, version);
    if (recomputedContent !== row.contentHash) {
      return {
        break: {
          seq: row.seq,
          kind: "content_mismatch",
          expected: row.contentHash,
          actual: recomputedContent,
          detail: "the row's fields no longer hash to its stored content_hash — the record was edited in place",
        },
        expectedSeq,
        prevRowHash,
      };
    }

    // 4. THE LINKED VALUE itself.
    const recomputedRowHash = auditRowHash(row.prevHash, recomputedContent);
    if (recomputedRowHash !== row.rowHash) {
      return {
        break: {
          seq: row.seq,
          kind: "row_hash_mismatch",
          expected: row.rowHash,
          actual: recomputedRowHash,
          detail: "row_hash does not follow from prev_hash and content_hash — the stored linked value was edited",
        },
        expectedSeq,
        prevRowHash,
      };
    }

    prevRowHash = row.rowHash;
    expectedSeq = row.seq + 1;
  }

  return { break: null, expectedSeq, prevRowHash };
}
