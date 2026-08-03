-- ADR-0063 — REGULAIT_DATA_KEY custody + restore-time verification.
--
-- ADR-0035 deliberately EXCLUDES the data key from the S3 backup: storing the
-- key beside the ciphertext it protects defeats the envelope split entirely.
-- That decision stands. Its consequence — a restore onto a new box recovers
-- every row and leaves every credential permanently undecryptable — was left
-- as the top deferred security item and is what these two tables close.
--
-- WHAT IS STORED HERE IS NOT THE KEY, AND CANNOT BECOME THE KEY.
-- `fingerprint` is `dk1:` + the first 16 bytes of
-- HMAC-SHA256(key = the 32 raw key bytes, msg = a fixed domain string), hex.
-- HMAC-SHA256 is a PRF: recovering the key from it means a preimage search
-- over 2^256. Truncation to 128 bits removes information rather than adding
-- any. It is therefore safe to print in a boot log, to store in this table
-- (which IS inside the backup), and to write into backup metadata — which is
-- the whole point: a backup artifact must be able to say WHICH key restores
-- it without carrying that key.
--
-- 1. data_key_state — the singleton "which key was this deployment's
--    ciphertext written under". The gateway compares it to the running key at
--    boot and REFUSES TO START on a mismatch (see apps/gateway/src/data-key.ts
--    for why refusing beats booting into silent decryption failure).
--
-- 2. data_key_attestations — an append-only record that a named human recorded
--    a named fingerprint out-of-band, on a named date, by a named method. It
--    is an honest artifact: it records a CLAIM about custody, it does not
--    verify custody. We cannot reach into an operator's password manager. What
--    it buys is that the absence of a claim is now a fact the product can see
--    and report — an unattested backup is a backup that may not be restorable.
--
-- Neither table is written by an upgrade. On the first boot after this
-- migration the gateway records the running key's fingerprint (having first
-- proved that key can decrypt existing ciphertext, if there is any), and
-- nothing else changes.

CREATE TABLE IF NOT EXISTS "data_key_state" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  -- non-secret, non-invertible. See the header.
  "fingerprint" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- bumped on every boot that matches, so "when did a running gateway last
  -- prove it held this key" is answerable without reading a log.
  "last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- set only by an explicit, operator-declared rotation (the documented
  -- override for the legitimate mismatch). NULL on a deployment that has
  -- never rotated.
  "rotated_from" text,
  "rotated_at" timestamp with time zone,
  CONSTRAINT "data_key_state_singleton" CHECK ("id" = 'singleton')
);

CREATE TABLE IF NOT EXISTS "data_key_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- the fingerprint the human says they recorded. Deliberately stored per
  -- attestation rather than joined to the singleton: after a rotation, an
  -- attestation of the OLD key must not silently appear to cover the new one.
  "fingerprint" text NOT NULL,
  -- the authenticated actor. Nullable only so a user deletion cannot erase the
  -- attestation record itself (ON DELETE SET NULL), which is why the label
  -- below is captured as text at attestation time.
  "attested_by_user_id" uuid,
  "attested_by_label" text NOT NULL,
  -- where they say they put it: password_manager | kms | escrow | offline | other
  "method" text NOT NULL,
  -- non-secret pointer, e.g. "1Password vault: Platform Ops". Free text, and
  -- the API refuses anything that looks like the key itself.
  "location_hint" text,
  "note" text,
  "attested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "data_key_attestations_user_fk" FOREIGN KEY ("attested_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "data_key_attestations_fingerprint_idx"
  ON "data_key_attestations" ("fingerprint", "attested_at" DESC);
