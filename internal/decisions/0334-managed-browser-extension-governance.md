# ADR-0334: Managed browser extension: govern AI assistants in browser tabs with the gateway's policy, inventory and audit trail

- **Status**: Proposed (owner direction 2026-11-15 via the lane E16 brief; surface (a) built, default off)
- **Date**: 2026-11-15
- **Index**: **Managed browser extension, surface (a): AI assistant sites in browser tabs. MV3, force-installed by the customer's browser management only; host permissions limited to the governed site catalogue; fails closed (blocks every governed site) until a signed, unexpired per-user policy says otherwise; corporate-account rules from the profile identity; DLP on the shared `dlp.secret.*` rules before a prompt leaves the browser; breach events tied to user, device and conversation; prompt capture off unless an admin turns it on (step-up, audited, on-screen notice). Off by default.**
- **Built in**: lane E16, PR 1 of 2 (this ADR, `agents/browser/`, the gateway routes). Browser-driving agents (surface (b)) get their own ADR in PR 2.
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
  That is a later PR with its own ADR.

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

1. **An unknown or disabled person gets nothing** (`user_unknown`): the profile account must match an active RegulAIt
   user (case-insensitive email).
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

The policy is signed into the endpoint agent's envelope (one envelope for both on-device enforcement points, so the
gateway has one signer shape) by **the browser policy key**, a key of its own (one key per purpose, as ADR-0195 decided
for the endpoint agent): operator-managed (`REGULAIT_BROWSER_POLICY_SIGNING_KEY` and `_KEY_ID`) or install-generated
in the install secrets directory on first enable, through the shared install-key generator and its strict reader.
Whether the endpoint agent's enforcement policy is later signed by this key or by the ADR-0195 SD4 key is the endpoint
lane's decision; the envelope already fits both. No key means no policy, so
turning governance on fails with `policy_signer_unavailable` rather than leaving extensions closed for good.

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
- A captured prompt (at most 16,000 characters) is enveloped under the data key, stored append-only with the same
  attribution as an event, and **read only one at a time with a `pseudonym_reveal` step-up bound to that capture**,
  audited.

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
  the endpoint agent's bulk token.

## Not in this slice (recorded as follow-ups)

- **Honest DLP limits:** a prompt sent by script without a key press or button click, voice input, pasted or dragged
  files, and text in iframes the composer lives in are not checked. A page-world fetch hook is a later, separate
  decision (it would put extension code in the page's world).
- **Inventory and detection:** events are evidence and audit rows; feeding them into the shadow-AI inventory and the
  detection engine is a follow-up through those lanes' documented contracts.
- **Turning a DLP rule off** for the browser (a relaxation, audited); today every shared rule is on.
- **Hardware-bound device keys** through native messaging to the endpoint agent's TPM or Secure Enclave key.
- **Retention** for `browser_events` and `browser_prompt_captures` (both refuse every DELETE today), and the RLS batch
  for the new tables (single-tenant register tables, like ADR-0261's).
- **Per-role site rules** (today a rule is org-wide; per-user entitlement comes from the user match and the posture).
- **Firefox and Safari** builds.
- **Browser-driving agents** (surface (b)): their own ADR and PR.

## Consequences

- The browser joins the gateway and the endpoint agent under one decision order, one audit chain and one set of
  credential rules. The policy is the gateway's; the extension only enforces it.
- A deployed extension blocks every governed AI site until browser governance is on and a site is allowed. That is the
  strict default (ADR-0180), and the deployment guide says so.
- Eleven admin routes ship without screens (KNOWN_UI_GAPS raised from 54 to 65, for the master's review on #453).
- The extension's governed sites change only with a new extension version, which is slower than editing a list, and
  is the price of never asking for `<all_urls>`.

## Owner questions (open)

1. Should a profile account that matches no RegulAIt user be blocked everywhere (built, the strict default), or get
   the org-wide site rules?
2. Should prompt capture keep captured prompts for a fixed time (and what time), now that retention is a follow-up?
3. Is Chromium-only acceptable for the first customers, or is Firefox needed early?
