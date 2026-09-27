-- ADR-0127 addendum / AER-027 — THE PDP CREDENTIAL STOPS BEING AN ADMIN KEY.
--
-- `POST /v1/authz/check` is admin-gated, so the only credential a proxy could
-- hold to ask it was an administrator API key — which reaches every other admin
-- route in the product. A data-plane proxy is the most exposed thing in a
-- deployment, and compromising it was therefore equivalent to compromising the
-- control plane. That is the wrong blast radius for a component whose entire
-- job is to ask one question.
--
-- WHY THIS COLUMN AND NOT A NEW CREDENTIAL TABLE. ADR-0066 virtual keys are
-- already a workload credential done correctly: never admin whatever the owner
-- is, reachable only on an explicit route allow-list, with an expiry, a
-- revocation and a last-used timestamp. Everything a PDP credential needs
-- exists and is tested. What was missing is that the allow-list was ONE set for
-- every key, so a credential able to ask an authorization question would also
-- have been able to dispatch models. `purpose` splits the allow-list in two and
-- keeps the separation in BOTH directions: a pdp key cannot dispatch, and a
-- dispatch key cannot ask.
--
-- DEFAULT 'dispatch' so every existing row keeps exactly the behaviour it has
-- today; this widens nothing on its own.
alter table virtual_keys
  add column purpose text not null default 'dispatch';

-- A CHECK rather than an enum: the set is small, closed, and a proxy routes on
-- it, so adding a member should be a reviewed migration rather than a value
-- somebody inserts.
alter table virtual_keys
  add constraint virtual_keys_purpose_ck check (purpose in ('dispatch', 'pdp'));

comment on column virtual_keys.purpose is
  'ADR-0127/AER-027. dispatch = ADR-0066 model-dispatch surfaces. pdp = POST /v1/authz/check ONLY: an authorization-question credential for a data-plane proxy, which is never admin and can change nothing. The separation runs both ways.';
