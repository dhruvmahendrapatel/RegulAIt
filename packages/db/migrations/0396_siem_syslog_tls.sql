-- ADR-0351 slice 1 (lane E32): a syslog destination for the ADR-0303 SIEM delivery, RFC 5424 messages over TLS with
-- RFC 5425 octet-counted framing. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is
-- idempotent. Sorts after `siem_delivery.sql`, which creates the table.
--
-- - `kind` gains 'syslog_tls'. A syslog destination has no Standard Webhooks secret (RFC 5425 has no message
--   signature; the receiver is authenticated by its TLS certificate), so `secret_ciphertext` becomes nullable and a
--   CHECK ties it to the kind: a webhook always has a secret, a syslog destination never has one and never allows
--   plaintext.
-- - `tls_ca_pem`: an optional PEM bundle of the CA(s) that issued the receiver's certificate (a private CA). It is a
--   public certificate, not a secret. Absent = the system trust store. Certificate verification is never turned off.
-- - `last_error_code` gains 'tls_handshake' (the receiver's certificate or handshake was refused).
-- No new functions or refusal triggers.

ALTER TABLE "siem_destinations" DROP CONSTRAINT IF EXISTS "siem_destinations_kind_check";
--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD CONSTRAINT "siem_destinations_kind_check" CHECK ("kind" IN ('webhook', 'syslog_tls'));
--> statement-breakpoint
ALTER TABLE "siem_destinations" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD COLUMN IF NOT EXISTS "tls_ca_pem" text;
--> statement-breakpoint
ALTER TABLE "siem_destinations" DROP CONSTRAINT IF EXISTS "siem_destinations_kind_fields_check";
--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD CONSTRAINT "siem_destinations_kind_fields_check" CHECK (
  ("kind" = 'webhook' AND "secret_ciphertext" IS NOT NULL AND "tls_ca_pem" IS NULL)
  OR ("kind" = 'syslog_tls' AND "secret_ciphertext" IS NULL AND "allow_plaintext_http" = false)
);
--> statement-breakpoint
ALTER TABLE "siem_destinations" DROP CONSTRAINT IF EXISTS "siem_destinations_tls_ca_pem_check";
--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD CONSTRAINT "siem_destinations_tls_ca_pem_check" CHECK (
  "tls_ca_pem" IS NULL OR char_length("tls_ca_pem") BETWEEN 1 AND 65536
);
--> statement-breakpoint
ALTER TABLE "siem_destinations" DROP CONSTRAINT IF EXISTS "siem_destinations_error_code_check";
--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD CONSTRAINT "siem_destinations_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" IN (
  'http_4xx', 'http_408', 'http_413', 'http_429', 'http_5xx', 'timeout', 'network', 'egress_blocked', 'no_data_key',
  'secret_unreadable', 'tls_handshake'));
