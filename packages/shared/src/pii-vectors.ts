/**
 * ADR-0117 — THE PII CONFORMANCE VECTOR SET.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS IN THIS REPOSITORY
 * ---------------------------------------------------------------------------
 * A sibling product kept its vector file somewhere else. The consequence is
 * that from a fresh clone its conformance test cannot run, its published score
 * cannot be reproduced by the customer it was quoted to, and the number
 * therefore means nothing that can be checked. This file is committed here, in
 * the same package as the detector, so `pnpm -r test` on a fresh clone
 * re-measures the score from scratch and any reader can disagree with a
 * specific line of it.
 *
 * ---------------------------------------------------------------------------
 * EVERY IDENTIFIER HERE IS SYNTHETIC OR OFFICIALLY PUBLISHED
 * ---------------------------------------------------------------------------
 * This matters more than usual, because the fixtures ARE identity numbers.
 * Each vector carries a `source` saying exactly where its value came from, and
 * there are only three legitimate answers:
 *
 *   "published"   — an example an issuing authority, a standards body or a
 *                   payment network publishes precisely so that software can
 *                   be tested against it (the BZSt IdNr example, the ATO's
 *                   TFN, the 4111… test card, the 555 fictional exchange).
 *   "constructed" — a value computed here to satisfy the scheme's published
 *                   check digit. It is arithmetic over a number nobody chose,
 *                   not a person's identifier.
 *   "reserved"    — a value the issuing authority has reserved so that it can
 *                   NEVER be issued to anybody (the HMRC QQ prefix, the
 *                   invalid-range US SSN 123-45-6789).
 *
 * A real person's identifier must never appear here, in a commit, or in a log.
 *
 * ---------------------------------------------------------------------------
 * AND THE NEGATIVES MATTER AS MUCH AS THE POSITIVES
 * ---------------------------------------------------------------------------
 * In `block` mode a false positive is a REFUSED REQUEST that the user cannot
 * route around, so a detector that fires on an order number is worse than one
 * that misses. Roughly half of this set is near-miss strings that must stay
 * silent: an order number shaped like a BSN, a Luhn-broken card, a US phone
 * that is not an SSN, a check letter that is one off.
 *
 * The vectors are NOT tuned to flatter the score. `DOCUMENTED_MISSES` below is
 * the list of things this detector is known NOT to catch, asserted as
 * explicitly as the positives — so a future change that quietly starts
 * catching one reddens a test and forces the honest limits to be rewritten,
 * and a buyer who tests the product themselves finds the gap already written
 * down rather than discovering it.
 */

import type { PiiCategory } from "./pii.js";

/** Bump when a vector is added, removed or changed. The measured score is
 * meaningless without saying which set it was measured over. */
export const PII_VECTOR_SET_VERSION = "2026-10-03.2";

export type VectorSource = "published" | "constructed" | "reserved";

export interface PiiVector {
  /** stable, so a failure names a vector rather than an index */
  readonly id: string;
  /** the category this vector exercises */
  readonly category: PiiCategory;
  /** the identifier or near-miss string, ALONE — the test supplies a carrier */
  readonly text: string;
  /** where the value came from; see the header */
  readonly source: VectorSource;
  /** the provenance in words, and for a negative, WHY it must not fire */
  readonly note: string;
}

// ===========================================================================
// POSITIVES — must be detected when their category is enabled
// ===========================================================================

export const POSITIVE_VECTORS: readonly PiiVector[] = [
  // --- the four base categories (live-verified; regression guard) ----------
  { id: "p.email.plain", category: "email", text: "dana@regulait.invalid", source: "constructed",
    note: ".invalid is the RFC 2606 reserved TLD — it can never resolve to a real mailbox." },
  { id: "p.email.subdomain", category: "email", text: "a.b+tag@mail.regulait.invalid", source: "constructed",
    note: "plus-addressed, sub-domained form of the same reserved TLD." },
  { id: "p.ssn.hyphenated", category: "ssn", text: "123-45-6789", source: "reserved",
    note: "the canonical never-issued US SSN used for documentation; area 123 group 45 serial 6789 passes the bounds but the number is a documentation placeholder." },
  { id: "p.card.visa.spaced", category: "credit_card", text: "4111 1111 1111 1111", source: "published",
    note: "the payment networks' published Visa test PAN." },
  { id: "p.card.mc.bare", category: "credit_card", text: "5555555555554444", source: "published",
    note: "the published Mastercard test PAN, unformatted." },
  { id: "p.phone.parens", category: "phone", text: "(415) 555-2671", source: "reserved",
    note: "555-01xx/555 exchange is reserved for fiction; no subscriber holds it." },
  { id: "p.phone.e164ish", category: "phone", text: "+1 415 555 2671", source: "reserved",
    note: "the same reserved exchange in +1-prefixed form." },

  // --- India, Aadhaar (Verhoeff) ------------------------------------------
  { id: "p.aadhaar.bare", category: "aadhaar", text: "234567890124", source: "constructed",
    note: "payload 23456789012 plus the Verhoeff check digit 4, computed here. Leading digit 2 is in the issued range." },
  { id: "p.aadhaar.spaced", category: "aadhaar", text: "3456 7890 1238", source: "constructed",
    note: "payload 34567890123 + Verhoeff 8, in UIDAI's printed 4-4-4 grouping." },
  { id: "p.aadhaar.hyphenated", category: "aadhaar", text: "9988-7766-5548", source: "constructed",
    note: "payload 99887766554 + Verhoeff 8, hyphen-grouped." },

  // --- Brazil, CPF (two mod-11 check digits) ------------------------------
  { id: "p.cpf.formatted", category: "cpf", text: "111.444.777-35", source: "published",
    note: "the worked example carried in the published CPF check-digit documentation." },
  { id: "p.cpf.bare", category: "cpf", text: "11144477735", source: "published",
    note: "the same published example unformatted." },

  // --- Netherlands, BSN (11-proef) ----------------------------------------
  { id: "p.bsn.bare", category: "bsn", text: "111222333", source: "published",
    note: "the long-published 11-proef worked example: 9*1+8*1+7*1+6*2+5*2+4*2+3*3+2*3-3 = 66 = 6*11." },
  { id: "p.bsn.constructed", category: "bsn", text: "123456782", source: "constructed",
    note: "computed to satisfy the 11-proef here." },

  // --- Canada, SIN (Luhn, assigned leading digit) -------------------------
  { id: "p.sin.bare", category: "sin", text: "135567980", source: "constructed",
    note: "Luhn-valid, leading digit 1 (an assigned range). Computed here." },
  { id: "p.sin.spaced", category: "sin", text: "435 567 987", source: "constructed",
    note: "Luhn-valid, leading digit 4, in the printed 3-3-3 grouping." },

  // --- Australia, TFN (weighted mod-11) -----------------------------------
  { id: "p.tfn.spaced", category: "tfn", text: "123 456 782", source: "published",
    note: "the ATO's published example TFN; weights 1,4,3,7,5,8,6,9,10 sum to 253 = 23*11." },
  { id: "p.tfn.bare", category: "tfn", text: "876543210", source: "constructed",
    note: "computed to satisfy the same weighted mod-11." },

  // --- Germany, IdNr (ISO 7064 MOD 11,10 + the §139b structural rule) -----
  { id: "p.steuerid.published", category: "steuer_id", text: "86095742719", source: "published",
    note: "the example carried in the BZSt/§139b documentation. Digit 7 appears twice and non-adjacently, so the triple rule does not engage — which is why it could not have caught the inverted triple rule this ADR fixed." },

  // --- France, NIR (mod-97 key) -------------------------------------------
  { id: "p.nir.bare", category: "nir", text: "185036912304532", source: "constructed",
    note: "body 1850369123045 (a widely-reproduced documentation body) with the key RECOMPUTED here: 1850369123045 mod 97 = 65, so the key is 32. Published restatements of this example quote the remainder and the key the wrong way round; BigInt was used to settle it." },
  { id: "p.nir.key97", category: "nir", text: "285077518588297", source: "constructed",
    note: "constructed so the body is an exact multiple of 97 and the key is therefore 97 — the one-in-ninety-seven case the pre-ADR-0117 code could not represent." },
  { id: "p.nir.spaced", category: "nir", text: "2 88 06 75 123 456 86", source: "constructed",
    note: "a constructed NIR in the spacing used on a French carte vitale." },

  // --- Spain, DNI / NIE (mod-23 check letter) -----------------------------
  { id: "p.dni.published", category: "dni_nie", text: "12345678Z", source: "published",
    note: "the canonical DNI documentation example; 12345678 mod 23 selects Z from TRWAGMYFPDXBNJZSQVHLCKE." },
  { id: "p.nie.x", category: "dni_nie", text: "X1234567L", source: "constructed",
    note: "NIE with the X prefix folded to 0; 01234567 mod 23 selects L." },
  { id: "p.nie.y", category: "dni_nie", text: "Y1234567X", source: "constructed",
    note: "NIE with the Y prefix folded to 1; 11234567 mod 23 selects X." },

  // --- Italy, Codice Fiscale (mod-26 check character) ---------------------
  { id: "p.cf.rossi", category: "codice_fiscale", text: "RSSMRA85T10A562S", source: "published",
    note: "the canonical 'Mario Rossi' documentation example; the check character S was recomputed here from the published odd/even tables." },
  { id: "p.cf.marte", category: "codice_fiscale", text: "MRTMTT25D09F205Z", source: "published",
    note: "the second canonical documentation example; check character Z likewise recomputed." },

  // --- United Kingdom, NINO (STRUCTURE ONLY — no check digit) -------------
  { id: "p.nino.bare", category: "nino", text: "AB123456C", source: "constructed",
    note: "a structurally admissible NINO. THERE IS NO CHECK DIGIT: this vector proves the shape matches, and proves nothing about the number being real." },
  { id: "p.nino.spaced", category: "nino", text: "AE 12 34 56 A", source: "constructed",
    note: "the same shape in HMRC's printed spacing." },

  // --- BATCH 2: formatting variants, added WITHOUT pre-checking the answer --
  // The first batch scored 29/29 and 30/30 on the first run, which is the
  // smell of a set chosen to agree with the detector. These were written down
  // as predictions and then run; the predictions and the outcomes are in
  // ADR-0117, including the one that was wrong.
  { id: "p.bsn.dotted", category: "bsn", text: "111.222.333", source: "published",
    note: "the published BSN example in the dotted 3-3-3 form." },
  { id: "p.sin.hyphenated", category: "sin", text: "135-567-980", source: "constructed",
    note: "a constructed Luhn-valid SIN, hyphen-grouped." },
  { id: "p.steuerid.spaced", category: "steuer_id", text: "86 095 742 719", source: "published",
    note: "the BZSt example in the 2-3-3-3 spacing German documents print." },
  { id: "p.cf.lowercase", category: "codice_fiscale", text: "rssmra85t10a562s", source: "published",
    note: "the published example in lower case, as a user would paste it from an email." },
  { id: "p.dni.spaced_letter", category: "dni_nie", text: "12345678 Z", source: "published",
    note: "the published DNI example with a space before the check letter." },
  { id: "p.cpf.in_json", category: "cpf", text: "{\"cpf\":\"11144477735\"}", source: "published",
    note: "the published CPF inside a JSON payload — the shape a connector or MCP tool argument actually carries, where the value is bounded by quotes rather than by whitespace." },
  { id: "p.nir.carte_vitale", category: "nir", text: "1 85 03 69 123 045 32", source: "constructed",
    note: "a constructed NIR in the exact spacing printed on a carte vitale." },

  // --- BATCH 4: two real print forms the AER-006 grammar dropped -----------
  // Narrowing each scheme to an explicit layout list (AER-006) listed only
  // 3.3.3 for the BSN and only 3.3.3-2 for the CPF. Both forms below fired
  // on the grammar before it and went silent after it; the review of that
  // change found them, and they are restored as layouts of their own.
  { id: "p.bsn.dotted_4_2_3", category: "bsn", text: "1234.56.782", source: "constructed",
    note: "p.bsn.constructed in the 4.2.3 dotted form the Belastingdienst prints as a fiscal number." },
  { id: "p.bsn.ons_kenmerk", category: "bsn", text: "Ons kenmerk 1234.56.782.T.SC.19.001", source: "constructed",
    note: "the same BSN at the head of a Belastingdienst letter reference, whose published SBR-taxonomy format is 1234.56.789.T.XX.jj.nnn. The dot after the ninth digit is followed by a letter, not a digit, so the run does not continue." },
  { id: "p.cpf.hyphen_9_2", category: "cpf", text: "111444777-35", source: "published",
    note: "the published CPF example as 000000000-00: the check-digit hyphen kept and the dots left out, as forms that strip punctuation key it." },
];

// ===========================================================================
// NEGATIVES — must NOT fire the named category
// ===========================================================================
// Every one of these is paired, in the conformance test, with a POSITIVE
// assertion on the same input proving the detector actually ran over it
// (M-033: a negative assertion is satisfied by a detector that never ran).

export const NEGATIVE_VECTORS: readonly PiiVector[] = [
  // --- the four base categories -------------------------------------------
  { id: "n.email.bare_domain", category: "email", text: "visit example.com or ask @dana", source: "constructed",
    note: "a domain and a social handle are not an address." },
  { id: "n.ssn.area_666", category: "ssn", text: "666-12-3456", source: "constructed",
    note: "area 666 is never issued." },
  { id: "n.ssn.serial_0000", category: "ssn", text: "123-45-0000", source: "constructed",
    note: "serial 0000 is never issued." },
  { id: "n.ssn.order_number", category: "ssn", text: "order 12-345-6789", source: "constructed",
    note: "an order number with the digits grouped 2-3-4 is not an SSN." },
  { id: "n.card.luhn_broken", category: "credit_card", text: "4111 1111 1111 1112", source: "constructed",
    note: "the published test PAN with its last digit changed — Luhn must reject it." },
  { id: "n.card.sequence", category: "credit_card", text: "1234 5678 9012 3456", source: "constructed",
    note: "a 16-digit non-Luhn sequence; a naive digit-run regex fires on this and Luhn must not." },
  { id: "n.phone.bare_ten", category: "phone", text: "id 4155552671", source: "constructed",
    note: "ten bare digits with no separators is an identifier, not a phone number." },
  { id: "n.phone.is_not_ssn", category: "ssn", text: "call 415-555-2671 today", source: "reserved",
    note: "a US phone in the reserved fictional exchange must not read as an SSN." },
  { id: "n.ssn.is_not_card", category: "credit_card", text: "123-45-6789", source: "reserved",
    note: "the reserved documentation SSN must not read as a card." },

  // --- international near-misses -------------------------------------------
  { id: "n.bsn.order_number", category: "bsn", text: "order number 111222334", source: "constructed",
    note: "the published BSN example with its last digit changed — the 11-proef must reject it. This is the single most important negative in the set: a bare nine-digit order number is the commonest thing a BSN detector destroys." },
  { id: "n.bsn.leading_zero_dropped", category: "bsn", text: "job 12345678", source: "constructed",
    note: "eight digits cannot be assessed as a BSN and must not be guessed at." },
  { id: "n.cpf.repdigit", category: "cpf", text: "111.111.111-11", source: "constructed",
    note: "a repdigit satisfies the CPF check digits arithmetically and is never issued." },
  { id: "n.cpf.wrong_check", category: "cpf", text: "111.444.777-36", source: "constructed",
    note: "the published CPF example with its second check digit changed." },
  { id: "n.sin.leading_zero", category: "sin", text: "046454286", source: "constructed",
    note: "Luhn-valid BUT leading digit 0, which Canada does not assign. Widely miscopied as a 'valid test SIN' because it is a valid LUHN example; it is not a valid SIN." },
  { id: "n.sin.leading_eight", category: "sin", text: "846454282", source: "constructed",
    note: "Luhn-valid but leading digit 8, a range Canada does not assign." },
  { id: "n.tfn.wrong_weight", category: "tfn", text: "123 456 789", source: "constructed",
    note: "the ATO example with its last digit changed — the weighted mod-11 must reject it." },
  { id: "n.aadhaar.leading_one", category: "aadhaar", text: "134567890123", source: "constructed",
    note: "leading digit 1 is reserved and never issued, whatever the check digit says." },
  { id: "n.aadhaar.inside_a_card", category: "aadhaar", text: "2345 6789 0124 9999", source: "constructed",
    note: "THE ANCHORING CASE. The first twelve digits are a Verhoeff-valid Aadhaar, but the run continues past them, so this is a sixteen-digit reference and not an Aadhaar. The pre-ADR-0117 anchor was satisfied by the scheme's own separator and fired here." },
  { id: "n.aadhaar.epoch_ms", category: "aadhaar", text: "ts 1758312000000", source: "constructed",
    note: "a thirteen-digit epoch-millisecond timestamp must not be sliced into a twelve-digit Aadhaar." },
  { id: "n.steuerid.wrong_check", category: "steuer_id", text: "86095742718", source: "constructed",
    note: "the BZSt example with its check digit changed." },
  { id: "n.steuerid.no_repeat", category: "steuer_id", text: "12345678909", source: "constructed",
    note: "the first ten digits contain no repeated value at all, which §139b requires." },
  { id: "n.nir.wrong_key", category: "nir", text: "185036912304533", source: "constructed",
    note: "a constructed NIR with its mod-97 key one out." },
  { id: "n.nir.bad_month", category: "nir", text: "185136912304532", source: "constructed",
    note: "month 13 is not an admissible NIR month code." },
  { id: "n.dni.wrong_letter", category: "dni_nie", text: "12345678A", source: "constructed",
    note: "the published DNI example with a wrong check letter." },
  { id: "n.dni.no_letter", category: "dni_nie", text: "ticket 12345678", source: "constructed",
    note: "eight digits with no letter carries nothing to validate and must not be guessed at." },
  { id: "n.cf.wrong_check", category: "codice_fiscale", text: "RSSMRA85T10A562X", source: "constructed",
    note: "the published Codice Fiscale example with a wrong check character." },
  { id: "n.cf.ordinary_word", category: "codice_fiscale", text: "INVOICE 24 A 01 B 123 C", source: "constructed",
    note: "a spaced reference of roughly the right shape must not read as a Codice Fiscale." },
  { id: "n.nino.reserved_qq", category: "nino", text: "QQ123456C", source: "reserved",
    note: "HMRC's documentation placeholder. Q is excluded as a first prefix letter precisely so this can never be a real NINO." },
  { id: "n.nino.reserved_pair", category: "nino", text: "NK123456A", source: "reserved",
    note: "NK is one of the reserved prefix pairs that is never allocated." },
  { id: "n.nino.bad_suffix", category: "nino", text: "AB123456E", source: "constructed",
    note: "the suffix letter runs A-D only." },

  // --- BATCH 2: ordinary strings from ordinary systems ---------------------
  // Chosen as the things a real prompt carries, then run. READ THE CAVEAT ON
  // `REALISTIC_CORPUS_RATES` BELOW BEFORE TAKING COMFORT FROM THESE PASSING:
  // each of these is ONE draw, and the schemes they dodge would have caught a
  // different draw of the same shape roughly one time in eleven.
  { id: "n.isbn13", category: "nir", text: "ISBN 978-3-16-148410-0", source: "published",
    note: "the published ISBN-13 documentation example." },
  { id: "n.uuid", category: "aadhaar", text: "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301", source: "constructed",
    note: "a UUID as a request id — hexadecimal with hyphens, so the letters break every digit-run scheme including the 12-digit Aadhaar." },
  { id: "n.iban", category: "steuer_id", text: "IBAN DE89370400440532013000", source: "published",
    note: "the published German IBAN documentation example; the leading letters and the 18-digit run must not yield an 11-digit IdNr." },
  { id: "n.dutch_mobile", category: "bsn", text: "mobile +31 612345678", source: "constructed",
    note: "THE MOST DANGEROUS NEGATIVE IN THIS SET, and it passes for the WRONG REASON. A Dutch mobile written after +31 is exactly nine digits. This particular one fails the 11-proef; 9.22% of them do not. See REALISTIC_CORPUS_RATES." },
  { id: "n.au_mobile", category: "tfn", text: "mobile 0412 345 678", source: "constructed",
    note: "an Australian mobile is ten digits, so it cannot be a nine-digit TFN." },
  { id: "n.us_ein", category: "sin", text: "EIN 12-3456789", source: "constructed",
    note: "a US employer identification number, nine digits grouped 2-7." },
  { id: "n.build_stamp", category: "steuer_id", text: "build 20260919.113045", source: "constructed",
    note: "a dotted build timestamp — an 8-digit date and a 6-digit time, the kind of string a CI prompt carries constantly." },
  { id: "n.money", category: "cpf", text: "price 1,234,567,890.12 USD", source: "constructed",
    note: "a comma-grouped currency amount; the commas are not a CPF separator, and the digit run either side is the wrong length." },
  { id: "n.git_sha", category: "nino", text: "sha 1234567890abcdef", source: "constructed",
    note: "a short git object id — hexadecimal, so the letters a-f break the digit-run schemes and the shape is not a NINO." },

  // --- BATCH 3: every-digit separators, one per published layout -----------
  // Each is a CHECKSUM-VALID identifier (its bare form is a positive above)
  // written with the layout's own separator after EVERY digit — a print form
  // no issuing authority uses, and the shape a dotted version, a serial or a
  // spaced reference carries. The pre-AER-006 grammar let one optional
  // separator follow every digit and fired on all nine of these. The grammar
  // is now the issuing authority's grouping and nothing wider, so these must
  // stay silent; being checksum-valid, they fail for the grammar alone.
  { id: "n.aadhaar.every_digit_spaced", category: "aadhaar", text: "2 3 4 5 6 7 8 9 0 1 2 4", source: "constructed",
    note: "p.aadhaar.bare with a space after every digit. Aadhaar's spaced layout is 4-4-4 and nothing else." },
  { id: "n.aadhaar.every_digit_hyphenated", category: "aadhaar", text: "2-3-4-5-6-7-8-9-0-1-2-4", source: "constructed",
    note: "p.aadhaar.bare with a hyphen after every digit. Aadhaar's hyphenated layout is 4-4-4 and nothing else." },
  { id: "n.cpf.every_digit_dotted", category: "cpf", text: "1.1.1.4.4.4.7.7.7.3.5", source: "published",
    note: "the published CPF example with a dot after every digit. CPF's layouts are 000.000.000-00 and 000000000-00 and nothing else." },
  { id: "n.bsn.every_digit_dotted", category: "bsn", text: "1.1.1.2.2.2.3.3.3", source: "published",
    note: "the published BSN example with a dot after every digit. BSN's dotted layouts are 3-3-3 and 4-2-3 and nothing else." },
  { id: "n.sin.every_digit_spaced", category: "sin", text: "4 3 5 5 6 7 9 8 7", source: "constructed",
    note: "p.sin.spaced with a space after every digit. SIN's spaced layout is 3-3-3 and nothing else." },
  { id: "n.sin.every_digit_hyphenated", category: "sin", text: "1-3-5-5-6-7-9-8-0", source: "constructed",
    note: "p.sin.hyphenated with a hyphen after every digit. SIN's hyphenated layout is 3-3-3 and nothing else." },
  { id: "n.tfn.every_digit_spaced", category: "tfn", text: "1 2 3 4 5 6 7 8 2", source: "published",
    note: "the ATO example with a space after every digit. TFN's spaced layout is 3-3-3 and nothing else." },
  { id: "n.steuerid.every_digit_spaced", category: "steuer_id", text: "8 6 0 9 5 7 4 2 7 1 9", source: "published",
    note: "the BZSt example with a space after every digit. The IdNr's spaced layout is 2-3-3-3 and nothing else." },
  { id: "n.nir.every_digit_spaced", category: "nir", text: "1 8 5 0 3 6 9 1 2 3 0 4 5 3 2", source: "constructed",
    note: "p.nir.bare with a space after every digit. The NIR's spaced layout is 1-2-2-2-3-3-2 and nothing else." },

  // --- BATCH 4: every-digit negatives for the two restored layouts ---------
  // The same construction as batch 3, over the digits of the batch-4
  // positives, so restoring 4.2.3 and 9-2 cannot have been done by widening
  // the grammar back to a separator after any digit.
  { id: "n.bsn.every_digit_dotted_4_2_3", category: "bsn", text: "1.2.3.4.5.6.7.8.2", source: "constructed",
    note: "p.bsn.dotted_4_2_3 with a dot after every digit. BSN's dotted layouts are 3-3-3 and 4-2-3 and nothing else." },
  { id: "n.cpf.every_digit_hyphenated", category: "cpf", text: "1-1-1-4-4-4-7-7-7-3-5", source: "published",
    note: "p.cpf.hyphen_9_2 with a hyphen after every digit. CPF's hyphen stands before the two check digits and nowhere else." },
];

/**
 * MEASURED against REALISTIC input shapes, not just random ones — 100,000
 * draws each, 2026-09-19, method in `pii-conformance.test.ts`.
 *
 * THIS IS THE TABLE THAT DECIDES WHETHER A JURISDICTION IS WORTH SWITCHING ON,
 * and it is the reason `n.dutch_mobile` above passing must not be read as
 * "Dutch mobiles are safe". It passed on one draw. The rate is the property.
 */
export const REALISTIC_CORPUS_RATES: readonly {
  readonly id: string;
  readonly shape: string;
  readonly category: string;
  readonly pct: number;
}[] = [
  { id: "r.nl_mobile_bsn", shape: "a Dutch mobile written as +31 6XXXXXXXX", category: "bsn", pct: 9.22 },
  { id: "r.order9_tfn", shape: "a bare 9-digit order number", category: "tfn", pct: 9.13 },
  { id: "r.order9_sin", shape: "a bare 9-digit order number", category: "sin", pct: 8.02 },
  { id: "r.part12_aadhaar", shape: "a bare 12-digit part number", category: "aadhaar", pct: 8.07 },
  // The one that matters most operationally: switching on all three 9-digit
  // jurisdictions at once compounds, because each gets an independent shot.
  { id: "r.order9_any", shape: "a bare 9-digit run, with bsn+sin+tfn ALL enabled", category: "any_of_three", pct: 24.03 },
];

// ===========================================================================
// DOCUMENTED MISSES — known NOT detected, asserted as firmly as the positives
// ===========================================================================
/**
 * The honest limits, made executable. Each entry is a REAL identifier form
 * that this detector does not catch. The conformance test asserts each one is
 * still not caught, so:
 *
 *   · the published score cannot be inflated by quietly forgetting a gap;
 *   · a future change that starts catching one FAILS a test, and whoever made
 *     it must come here and rewrite the limit rather than leave a stale claim
 *     in the ADR and on a slide.
 */
export const DOCUMENTED_MISSES: readonly PiiVector[] = [
  { id: "m.bsn.leading_zero", category: "bsn", text: "12345678", source: "constructed",
    note: "A BSN whose leading zero was dropped by a spreadsheet. Eight digits are indistinguishable from any eight-digit number, so it is NOT detected. Real, and common in imported data." },
  { id: "m.tfn.legacy8", category: "tfn", text: "12345678", source: "constructed",
    note: "The legacy 8-digit TFN. Accepting 8 digits would collide with too many order numbers, so it is NOT detected." },
  { id: "m.nir.corsica", category: "nir", text: "1 85 03 2A 123 045 32", source: "constructed",
    note: "Corsica's 2A/2B department codes put a LETTER inside the numeric body. NOT detected — the mod-97 key rule cannot consume it." },
  { id: "m.cf.omocodia", category: "codice_fiscale", text: "RSSMRA85T10A56RS", source: "constructed",
    note: "The omocodia variant substitutes letters for digits to break a collision. NOT detected." },
  { id: "m.aadhaar.masked", category: "aadhaar", text: "XXXX XXXX 0124", source: "constructed",
    note: "An Aadhaar masked to its last four digits, which is how it is most often quoted in support tickets. NOT detected — there is nothing left to checksum." },
  { id: "m.aadhaar.vid", category: "aadhaar", text: "6100000000000024", source: "constructed",
    note: "A 16-digit Aadhaar Virtual ID. NOT detected — it is a different scheme with a different length." },
  { id: "m.dni.no_letter", category: "dni_nie", text: "12345678", source: "constructed",
    note: "A DNI written without its check letter. NOT detected, deliberately: there is nothing to validate, and guessing would refuse every eight-digit number in the deployment." },
  { id: "m.cpf.space_grouped", category: "cpf", text: "111 444 777 35", source: "published",
    note: "The published CPF example grouped with SPACES instead of its printed dots and hyphen. NOT detected: CPF's layouts are 000.000.000-00 and 000000000-00 besides the bare run, and neither puts a space anywhere. Predicted as a miss before it was run, and it is one — adding a space-grouped layout would make every 11-digit reference grouped 3-3-3-2 with spaces a CPF candidate, which is the wrong trade at a 1.02% base rate." },
  { id: "m.cpf.cnpj", category: "cpf", text: "11.222.333/0001-81", source: "constructed",
    note: "A CNPJ is a COMPANY registration, not a person, and is NOT detected by the CPF rule. Listed so nobody reads 'Brazil covered' as covering it." },
];
