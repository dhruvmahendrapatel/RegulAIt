# ADR-0334: Managed browser extension: govern AI assistants in browser tabs with the gateway's policy, inventory and audit trail

- **Status**: Proposed (owner direction 2026-11-15 via the lane E16 brief; surface (a) built, default off)
- **Date**: 2026-11-15
- **Index**: **Managed browser extension, surface (a): AI assistant sites in browser tabs. MV3, force-installed by the customer's browser management only; host permissions limited to the governed site catalogue; fails closed (blocks every governed site) until a signed, unexpired per-user policy says otherwise; corporate-account rules from the profile identity; DLP on the shared `dlp.secret.*` rules before a prompt leaves the browser; breach events tied to user, device and conversation; prompt capture off unless an admin turns it on (step-up, audited, on-screen notice). Off by default.**
- **Built in**: lane E16 (this ADR, `agents/browser/`, the gateway routes). Browser-driving agents (surface (b)) are
  **superseded by [ADR-0364](0364-governed-rpa-robots.md)** (lane E45; owner decision 2026-11-21): no separate ADR is written for them.
- **Migration**: `pending/browser_governance.sql`, numbered at merge (ADR-0252)
- **Related**: ADR-0055 and ADR-0195 (shadow-AI discovery, the endpoint agent's enrolment and pseudonyms), ADR-0298
  (on-device enforcement: signed policy, fail closed), ADR-0251 (one governed decision core), ADR-0176 (open source
  first), ADR-0180 (secure by default), ADR-0200 (engineering guidelines, 3NF, security checklist), ADR-0234 (row-level
  security), ADR-0252 (merge-time numbering)

## Context

The gateway governs AI calls that come to it, and the endpoint agent (ADR-0195, ADR-0298) discovers and governs AI
tools on a laptop. Neither sees the most common ungoverned use: a person typing into an AI assistant in a browser tab.
Shadow-AI discovery can tell an admin that a site was visited (a DNS or proxy sighting); it cannot stop a denied site,
check which account a person uses, or stop a credential being pasted into a prompt.

The owner asked (2026-11-15) for the browser to be governed through the same policy engine, inventory and audit trail
as the gateway and the endpoint agent, with privacy and security as the core of the design. Two surfaces:

- **(a) AI assistants in browser tabs:** block a denied site, enforce corporate-account rules, block a prompt that
  matches a DLP rule before it leaves the browser, and record breaches tied to user, device and conversation.
- **(b) Browser-driving agents:** record their actions as an auditable timeline and apply the same tool-call policies.
  **Superseded by [ADR-0364](0364-governed-rpa-robots.md) §4-§7** (owner decision 2026-11-21, relayed by the master):
  free-form browser control is the first-party, high-risk, opt-in `@playwright/mcp` server governed through the same
  tool-call gate, with redacted screenshot evidence per call, and lane E45 builds it.

A browser extension is a very privileged piece of software in a very hostile place. It runs beside every page the
person opens, a page's script is attacker-controlled by default, and the person who installs or removes it is the
person it governs. So this ADR is mostly about what the extension cannot do.

## Decision

### 1. Deployment: managed only, Chromium first

- **Manifest V3, Chromium-based browsers** on macOS, Windows and Linux (minimum version 137, for MV3 redirect rules
  and WebCrypto Ed25519 by default). Firefox and Safari are later work if asked for.
- **Force-installed by the customer's browser management** (an `ExtensionInstallForcelist`-style policy pushed by MDM
  or the browser's cloud management). There is no store listing and no user install path. The package
  (`agents/browser/`) builds an unpacked extension; the customer's packaging signs it into a CRX for their own update
  channel. A person cannot disable or remove a force-installed extension.
- **Configuration comes only from managed storage** (`chrome.storage.managed`, schema `managed_schema.json`): the
  gateway URL (https only), a bulk enrolment token and the gateway's policy public key(s). The person cannot change
  managed storage. A missing or malformed value means the extension does nothing but block.
- **Default off at the org level.** Every extension route refuses `browser_governance_disabled` until an admin turns
  browser governance on, which is a `settings_relax` step-up, audited. With it off, a deployed extension blocks every
  governed site (section 3), so an admin turns it on before rolling the extension out.

### 2. Least privilege

The manifest is generated from the governed site catalogue at build time and pinned by a test:

- **Host permissions:** exactly the catalogue sites (https, the host and its subdomains). No `<all_urls>`.
- **Permissions:** `storage`, `alarms`, `declarativeNetRequest`, `identity`, `identity.email`. Nothing else: no
  `tabs`, `history`, `webNavigation`, `webRequest`, `scripting`, `cookies` or `nativeMessaging`.
- **It never reads browsing history.** It never learns about a navigation outside the catalogue: the browser applies
  its rules without telling it, and its content script runs only on catalogue sites.
- **Identity:** `chrome.identity.getProfileUserInfo` reads only the browser profile's signed-in account (an email and
  an opaque id). That is the one identity input, used for account rules and attribution.
- **The site catalogue** is the consumer AI web app entries of the frozen shadow-AI catalogue (ADR-0055 v1, by id),
  copied into the shared contract and held equal to the catalogue by a test. The signed policy can narrow it, never
  widen it: the browser itself enforces the manifest. Adding a site is a new extension version through the customer's
  browser management, which is the change control we want for a new permission.
- **Extension pages** keep MV3's strict CSP, stated explicitly (`script-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`). No remote code, no `eval`, no source maps in the build.

### 3. Fail closed

- **The `fail_closed` ruleset ships enabled.** It redirects every catalogue site (top-level and frames) to the
  extension's block page. If the service worker never starts, crashes, or the person's machine is offline from
  install, the sites stay blocked.
- **It is switched off only after a verified policy's own rules are in place**, and switched back on *before* those
  rules are removed, so there is no window in which nothing blocks.
- **A policy is used only when all of these hold:** it arrives in the endpoint agent's signed-policy envelope
  (ADR-0298: `{keyId, payload, signature}`, Ed25519 over the exact payload bytes, the same key id shape), the `keyId`
  names a key pinned in managed storage, the signature verifies (WebCrypto), the payload is a browser policy the shared
  schema accepts (unknown members refused), for this device's id, not issued more than five minutes in the future,
  and not past `notAfter`. A
  policy lives four hours and is refreshed every 30 minutes. An expired policy is no policy: there is no last-known-good.
- **The content script is a second layer:** on a governed page it asks the worker for the verdict and, if the page is
  blocked (a single-page app navigation, a rule update race), replaces the page with the block page. If the worker
  does not answer, it blocks.

### 4. The policy is the gateway's decision, per user

`POST /v1/browser-extension/policy` returns the policy for the device and the profile account it names. The gateway
computes it deterministically, in the governed core's order (ADR-0251):

1. **A disabled person gets nothing** (`user_disabled`). **Neither does an account RegulAIt does not recognise**
   (`account_not_recognised`): a profile account that matches no RegulAIt user (case-insensitive email), or a
   signed-out profile, gets a policy that denies every site, audited as `browser-policy-unrecognised-account`
   (pseudonym only). This reverses owner decision B1, which gave such an account the org-wide rules (§14).
2. **The execution posture** (the kernel's `executionGate`, the same kill switch every governed call obeys) can only
   remove access: a halted, read-only or approval-required deployment denies every site (`execution_posture`). A prompt
   sends data out, so it counts as a write, and the browser has no per-call approval queue.
3. **The admin's site rule:** allow or deny per catalogue site, with optional **account domains**. **No rule means
   deny** (`no_site_rule`). Allowing a site is a `settings_relax` step-up bound to the site and its domains.

The policy carries every catalogue site with its decision, the account domains, the DLP rule ids, the mode
(`enforce`, or `audit` which is a step-up relaxation: decide and record, never block) and the capture switch.

**Account rules** are checked in the extension against the profile account signed in *now*: an allowed site with
account domains is blocked (`account_not_allowed`, `account_signed_out`) unless the profile's email is in one of them.
A sign-in change triggers a refetch.

The policy is signed into the endpoint agent's envelope by **the device-policy signer** (`device-policy-signer.ts`,
owner decision B4): one rotatable signer for every on-device enforcement point, the browser now and the endpoint agent's
ADR-0298 policy when lane E13 adopts it. It is a key of its own (one key per purpose, ADR-0195):

- **Operator-managed:** `REGULAIT_DEVICE_POLICY_SIGNING_KEY` names a file of 1 to 8 PKCS#8 Ed25519 keys, read by the
  issuer key file's own reader (`readSigningKeyFile`, factored out of `identity-signing-keys.ts` for this). With one
  key it signs; with more, `REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID` names the signer, and a missing or unknown id is
  `invalid`, never a guess.
- **Install-generated:** `<REGULAIT_INSTALL_SECRETS_DIR>/device-policy-signing-key.pem`, created on first enable by the
  shared install-key generator and read by its strict reader.
- **Rotation without a gap:** every configured key is published (the settings read and the managed config list them,
  at most 4 in a device's storage), so devices pin the next key before it signs; then the active key id moves to it;
  then the old key is dropped from the file and from managed storage.
- The key id is `device-policy-` + 24 hex of SHA-256 over the raw public key (the envelope's key-id shape).
- No key means no policy, so turning governance on fails with `policy_signer_unavailable` rather than leaving
  extensions closed for good.

No model is called anywhere on this path. Every permission and governance decision is a data check.

### 5. DLP before the prompt leaves the browser

- **Rules:** only the shared `dlp.secret.*` credential rules (packages/shared `CREDENTIAL_MATERIAL_RULES`), in their
  **RE2** form (`re2js`, linear time) exactly as the endpoint agent compiles them in Go, lookarounds rewritten the
  same way. The RE2 table lives in `packages/shared/src/dlp-secret-re2.ts` (subpath `@regulait/shared/dlp-secret-re2`)
  so any TypeScript consumer reuses it; the extension bundles it. The policy names which rule ids are on; it never carries a pattern (no regex is
  taken from data). A test holds the table equal to the shared rules (ids and source digests) and runs the endpoint
  agent's vectors through it.
- **When:** at send time, in the capture phase before the page's own handlers: Enter (not Shift+Enter) or Ctrl/Cmd+Enter
  in the prompt composer, a send button, or a form submit. A match stops the send and shows a notice that says why
  (never the matched text). In `audit` mode the prompt goes and a `would_block` event is recorded.
- **The text is read once, from the composer, at that moment,** and is never stored, logged or sent unless prompt
  capture is on (section 7); a prompt that matched a rule is never captured.

### 6. Events: breaches tied to user, device and conversation

`POST /v1/browser-extension/events` takes up to 50 events: kind (`site_blocked`, `account_blocked`, `dlp_blocked`),
outcome (`blocked`, `would_block`), a fixed code, the site id, the matched rule ids, and the page path (no query or
fragment). The gateway stores, append-only:

- the **device** (its registered key), the **user** the profile account matched (a foreign key, point-in-time), the
  profile account's **pseudonym** (ADR-0195's keyed hash; the address itself is kept only enveloped in the existing
  pseudonym table, revealed by a `pseudonym_reveal` step-up), and the **conversation** as a keyed hash of the site and
  path. The path, the account name and any text are never stored.
- one **audit-chain row per batch** naming every event; events deduplicate on (device, event id).

The block page records a redirected navigation itself (it knows only the code and site id), so a blocked visit is
recorded even when the page never loads.

### 7. Prompt capture: off unless an admin turns it on

- Off by default. Turning it on is a `settings_relax` step-up, audited.
- While it is on, the extension shows a **persistent on-screen notice** on every governed site ("Your organisation
  records prompts on this site"), and the extension refuses to capture unless the signed policy says capture is on.
- A captured prompt (at most 16,000 characters) is enveloped under the data key (and in `CIPHERTEXT_COLUMNS`, so the
  data-key re-encryption walk covers it), stored append-only with the same attribution as an event, and **read only
  one at a time with a `pseudonym_reveal` step-up bound to that capture**, audited.
- **Retention (owner decision B2):** kept `prompt_capture_retention_days`, **30 by default** (1 to 3650); keeping them
  longer than the current setting is a `settings_relax` step-up, audited; shortening is not. The hourly sweep
  `browser-prompt-capture-retention-sweep` deletes what is past it, in batches, with one audit row per pass that deletes.
  The append-only guard admits that DELETE only under the transaction-local cutoff the sweep sets, when the cutoff is
  in the past by the database clock and the row arrived before it (the ADR-0302 pattern); a forged future cutoff
  deletes nothing.

### 8. Every message is authenticated per device and replay-protected: the endpoint agent's identity path

The extension does not get a device scheme of its own. It is a **workload identity of the new kind
`browser_extension`**, through exactly the path the endpoint agent uses (ADR-0195 SD4b):

- **Registration** (`POST /v1/browser-extension/register`, the only auth-exempt route) takes the bulk enrolment token
  (`rgbe_` + 64 hex, compared by SHA-256, capped by a required device cap, at most 30 days, revocable) and the
  extension's P-256 public key. The key is prepared and bound by S6 (`prepareRunnerKey`, `bindPreparedCredentialTx`:
  one key, one identity, ever) to a new `browser_extension` identity with no grants; the device row names that
  identity. The same key again is idempotent; the cap holds under a row lock.
- **The device key** is created by WebCrypto with `extractable: false` and kept as a CryptoKey in IndexedDB: its bytes
  never exist in JavaScript and page script cannot reach the extension's storage. Nothing secret is kept in
  `chrome.storage` (only the device id and client id, which prove nothing).
- **Every other request** carries an **S7 self token**: `client_credentials` with a `private_key_jwt` assertion by the
  device key, DPoP-bound to that key (RFC 9449), for the `/v1/browser-extension` resource, and a fresh DPoP proof per
  request with the gateway's nonce. The shared OAuth layer verifies the token, the proof's one-use `jti` (the replay
  store), the binding, the identity and the device on every request, before a handler runs; the route ceiling keeps
  the token to the policy, events and prompt-capture routes (`403 workload_scope` elsewhere).
- **Body integrity** rests on TLS, as for every DPoP-bound call; the request body is not separately signed. (The
  endpoint agent adds a report signature on its reports; generalising that into a shared signed-body check is
  recorded as a follow-up rather than built twice.)
- A revoked device is refused at the token endpoint and on every route (`device_revoked`, which the extension treats
  as final), and blocks every site (no policy). Its identity can also be revoked through the S6 identity routes.
- Bodies are at most 64 KiB.

### 9. The product UI

The extension's own UI is minimal: the block page and two on-page notices, in a closed shadow root, styled only with
the shared `--rg-*` tokens (DESIGN_GUIDELINES: British English, sentence case, no codes as labels, no vendor names).
The admin screens (settings, site rules, enrolment tokens, devices, events, reading a capture) are built by the UI
builder: the eleven admin routes are `KNOWN_UI_GAPS` entries pointing at #453.

### 10. Open-source search (ADR-0176, 2026-11-15)

- **Repo first (reused, not rebuilt):** the endpoint agent's device identity (S6 key binding, S7 DPoP-bound self
  tokens, the replay store, revocation, the route ceiling); its signed-policy envelope (ADR-0298); the shared
  `dlp.secret.*` rules and the endpoint agent's RE2 rewrites and test vectors; SD0's pseudonyms (`pseudonymise`, the
  pseudonym key); the kernel's `executionGate`; the step-up and audit paths; the install-key generator and reader;
  the data-key envelope (`encryptSecret`); the endpoint agent's test client (given a resource parameter).
- **Used (open source):** `jose` 6.2.14 (MIT, already pinned) for the client assertion and DPoP proofs; WebCrypto for
  Ed25519 verification; `re2js` 2.8.8 (MIT, already pinned) for the RE2 table; `zod` (already pinned) for the shared
  contract; `esbuild` 0.28.2 (MIT, already in the lockfile) to bundle; `@types/chrome` 0.3.7 (MIT) for types. All
  pinned, all air-gapped at run time.
- **webextension-polyfill:** rejected. It is MPL-2.0 (not on our licence list) and not needed: MV3 Chromium APIs return
  promises natively.
- **WXT and @crxjs/vite-plugin (MIT):** extension build frameworks. Not used: they generate the manifest themselves,
  and ours must be generated from the catalogue and pinned by a test; esbuild bundling three entry points is enough.
- **@noble/curves (MIT):** not needed; WebCrypto signs and verifies Ed25519 and P-256 through `jose`.
- **Written here, because it is RegulAIt:** the manifest and rule generation, the policy semantics and the evidence
  format. The RE2 table mirrors the endpoint agent's Go table, held equal to it and to the shared rules by test; it is
  in `packages/shared` so it is written once for TypeScript.

### 11. Threat model, honestly

- **A malicious page** cannot read the extension's storage, key or shadow-root UI, cannot message the worker (only this
  extension's content scripts can, and the worker takes the site from the sender's URL, never the message), and cannot
  stop the network rules. It can try to send a prompt by script without a key press or a click; the DLP check does not
  see that (below).
- **The person** cannot change managed storage, remove a force-installed extension or forge a policy. A person with
  local admin rights can remove managed policy from their own machine, the same limit as every managed rung
  (ADR-0298); a device that stops reporting is visible on the devices list.
- **Incognito and guest profiles:** a force-installed extension does not run in incognito unless the browser allows it.
  The deployment guide tells the admin to disable incognito and guest mode, or allow the extension in incognito, by
  browser policy.
- **Another browser** on the same machine is not governed by this extension; the endpoint agent and network controls
  remain the answer there.
- **A leaked enrolment token** registers devices up to its cap until it expires or is revoked, the same trade-off as
  the endpoint agent's bulk token. Issuing one is a `settings_relax` step-up bound to its label, cap and lifetime.
- **The profile account is the device's claim.** A device registered with a leaked token could name any colleague's
  email. So a device is bound to the first account it presents and refuses any other (section 12), and every row says
  its attribution is `device_asserted`. Verifying an identity-provider ID token is the follow-up that removes the claim.

## Not in this slice (recorded as follow-ups)

- **Honest DLP limits:** a prompt sent by script without a key press or button click, voice input, pasted or dragged
  files, and text in iframes the composer lives in are not checked. A page-world fetch hook is a later, separate
  decision (it would put extension code in the page's world).
- **Inventory and detection:** events are evidence and audit rows; feeding them into the shadow-AI inventory and the
  detection engine is a follow-up through those lanes' documented contracts.
- **Turning a DLP rule off** for the browser (a relaxation, audited); today every shared rule is on.
- **Hardware-bound device keys** through native messaging to the endpoint agent's TPM or Secure Enclave key.
- **Retention for `browser_events`** (they hold no prompt text and refuse every DELETE today).
- **Verified attribution:** an identity-provider ID token from `chrome.identity`, checked by the gateway, in place of
  the device-asserted account (section 12; PENDING fragment).
- **The gateway origin in `host_permissions` and CORS** for the extension origin, so registration passes a real
  Chromium preflight (it fails closed today; PENDING fragment).
- **In-app, audited rotation of the device-policy key** (the issuer key's activate/rotate/revoke lifecycle); today
  rotation is the operator's file and active key id.
- **Per-role site rules** (today a rule is org-wide; per-user entitlement comes from the user match and the posture).
- **Firefox** is a later slice (owner decision B3; PENDING fragment), and Safari after it.
- **Browser-driving agents** (surface (b)): superseded by ADR-0364 (lane E45), not a follow-up of this ADR.

## 12. Review fixes (#867, 2026-11-18)

The security and code reviews at `4398879` asked for these; each is built and tested in
`zz-adr0334-browser-governance.test.ts`.

- **Account binding (security 1).** `browser_devices` gains `bound_subject` (the pseudonym), `bound_user_id` and
  `bound_at`. The first non-empty profile account a device presents binds it (audited `browser-device-account-bound`).
  After that, `/policy`, `/events` and `/prompt-captures` refuse any other account, or none, with 409
  `account_mismatch` (audited `browser-device-account-mismatch`, pseudonyms only) and attribute nothing. The extension
  treats 409 as a refusal and fails closed. Events and captures carry `attribution = 'device_asserted'` (a CHECK allows
  only that value until verified attribution exists).
- **Row-level security (security 2).** All seven tables ENABLE and FORCE RLS. An admin, `system_task` (the retention
  sweep) and `migration` reach every row. The extension runs under `credential_request` in a transaction that names
  its workload identity in `regulait.browser_identity_id`. It reads the settings, site rules and tokens, updates only
  the token counter, and reaches only its own device row and its own events and captures. `browser-device.ts` enters
  that scope itself, because the token endpoint and the self-token check run outside the request's scope.
- **List contract (code 1).** The token, device and event lists answer through `answerListPage` with keyset
  `ListSpec`s on `(created_at, id)`, `(registered_at, id)` and `(received_at, id)`. A batch's events share one
  `received_at`, and the id tie-breaker pages through them without dropping any. The event list no longer returns
  `userId` beside the pseudonym.
- **Settings under the lock (code 2).** The settings write locks the singleton row, judges the relaxations on the
  locked row, and claims the step-up inside the same transaction. A refused claim rolls the write back. The audit
  records `settingTransitions` (old to new, ADR-0181).
- **Smaller fixes.** The token and device lifecycles are ADR-0348 `defineMachine` tables (derived states, so they are
  not in the CHECK-backed `STATE_MACHINES` registry). Client timestamps outside now minus 7 days to now plus 300 seconds
  are refused `invalid_body`. Issuing an enrolment token is a step-up. The `devices_enrolled` cap counter has its
  ADR-0200 exception comment.
- **Filed as issues, not fixed here:** the `user_disabled` bypass through a personal account (it conflicts with owner
  decision B1, so it is the owner's call; the owner reversed B1 on 2026-11-21, §14); CORS and the gateway origin; audit flooding from bad-token registrations;
  forged `block.html` events.

## 13. Extension hardening (2026-11-21: issues #1029, #1030 and #1031)

- **The gateway origin is pinned at build time (#1029).** The customer builds the extension they sign with
  `scripts/build.mjs --gateway-origin https://…`. That origin becomes one more host permission. Only the worker uses
  it: it is in neither the content-script nor the web-accessible matches. So the worker calls the gateway without CORS,
  and the gateway needs no CORS handling. The same origin is compiled into the bundle (`src/guards.ts`), and a managed
  `gatewayUrl` with any other origin is refused. A tampered managed configuration therefore cannot send the device's
  key, enrolment token or reports anywhere else. A build with no pinned origin reaches no gateway and keeps every
  governed site blocked (the strict default). Rule 9 compared two approaches:
  - `@fastify/cors` (MIT, maintained), allowing `chrome-extension://<id>` on the four extension routes and the token
    endpoint. Rejected: it adds a cross-origin surface and an extension-id setting to the gateway, and it would not stop
    a changed `gatewayUrl`.
  - `optional_host_permissions` with a runtime request. Rejected: it needs a user gesture, which a force-installed
    extension cannot rely on, and it grants far more than one origin.
- **Block-page records are checked (#1031).** The block page must be web-accessible for a redirect to reach it, so a
  governed site could open it with any code. The worker now records a `blocked` event only when all of these hold:
  - its own current verdict for that site is the same block with the same code;
  - the message comes from a top-level frame;
  - it is the first record for that site and code in a minute.
  A site can no longer forge a block that the policy would not apply, or flood the queue.
- **Unauthenticated refusals are coalesced (#1030).** A registration can be refused before any enrolment token is
  known: no token, an unknown token, a malformed body, or governance off. For each code, the first such refusal in a
  minute is audited, and the rest of that minute are counted. The count is written as one summary row
  (`coalesced: true`, `suppressed: n`) when the minute ends. A refusal against a known token is still audited every
  time. The counter is per process, and a count still open when the process exits is lost. That is accepted, because
  the row bounds audit volume from unauthenticated callers and is not evidence of any one request.

## 14. B1 reversed: an unrecognised account gets nothing (owner decision 2026-11-21, #1028)

The #867 security review found that B1 let a disabled person around `user_disabled`. They enrol a new browser, or
use one never bound to their work account, and sign it in with a personal account. That account matches no
RegulAIt user, so B1 gave it the org-wide site rules. The owner reversed B1 on 2026-11-21 (relayed by the master),
and because this is a security-checklist gap it is blocking under ADR-0180. As built:

- `buildBrowserPolicy` allows a site only for a recognised, active RegulAIt user. A profile account that matches no
  user, or no account at all, gets `account_not_recognised` on every site. A disabled user still gets
  `user_disabled`.
- The policy route audits each such issue as `browser-policy-unrecognised-account` (effect `deny`, pseudonym only,
  and whether the profile was signed in). This replaces B1's `browser-policy-unmatched-account` allow row.
- The block page says "Sign in with your work account".
- No admin setting brings B1 back. A relaxation for, say, contractors with personal accounts would be its own
  decision: a `settings_relax` step-up, off by default.
- A regression test reproduces the bypass. With a site allowed and the admin disabled, a fresh device signed in with a
  personal account, and a fresh signed-out device, both get every site denied.

## Consequences

- The browser joins the gateway and the endpoint agent under one decision order, one audit chain and one set of
  credential rules. The policy is the gateway's; the extension only enforces it.
- A deployed extension blocks every governed AI site until browser governance is on and a site is allowed. That is the
  strict default (ADR-0180), and the deployment guide says so.
- Eleven admin routes ship without screens (KNOWN_UI_GAPS raised from 54 to 65, for the master's review on #453).
- The extension's governed sites change only with a new extension version, which is slower than editing a list, and
  is the price of never asking for `<all_urls>`.

## Owner decisions (2026-11-15, relayed by the master on #867)

- **B1 (reversed 2026-11-21, §14):** a browser profile signed in with an account that matches no RegulAIt user gets the org-wide site rules, not
  a block everywhere. It stays audited, and corporate-account rules stay enforced where the org requires them. (Built:
  section 4. A matched but disabled person still gets nothing.)
- **B2:** captured prompts are kept 30 days by default, as an admin setting, and deleted automatically after that; a
  longer period is an audited `settings_relax` with step-up. The deletion is built now, not as a follow-up. (Built:
  section 7.)
- **B3:** Chromium-based browsers only for now; Firefox is a later slice, recorded as a PENDING fragment.
- **B4:** one rotatable device-policy signer signs both browser and endpoint policies; lane E13 adopts it. (Built:
  section 4, `device-policy-signer.ts`.)
- **Surface (b), 2026-11-21:** browser-driving agents belong to ADR-0364 (Robots, lane E45), which already decides
  their policy (a high-risk, opt-in first-party `@playwright/mcp` server under the ADR-0251 gate, egress limited to the
  authorised targets) and their timeline (per-call redacted screenshots as run evidence). E16 writes no separate ADR and
  builds nothing for them; lane E16 continues with the extension's own follow-ups.
