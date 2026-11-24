# Offline signed detection rules

The feed is an optional additional set of prompt-injection rules. It is off on installation. It never downloads
content or sends prompts, matches or customer data to a publisher. Imported rules add to the existing detectors;
they do not replace built-in or vendored content. The first format accepts injection rules only. Secret rules,
MCP heuristics, executable code and unknown fields are refused.

The installation operator configures trusted Ed25519 **public** keys through `REGULAIT_DETECTION_FEED_KEYS`, or a JSON
file through `REGULAIT_DETECTION_FEED_KEYS_FILE` (set one, not both):

```json
[{"keyId":"publisher-key","publicKeyPem":"<Ed25519 public PEM>"}]
```

A signer prepares this data document outside the gateway:

```json
{
  "format":"regulait.detection-feed/v1",
  "feedId":"public-rules",
  "version":1,
  "issuedAt":"2026-11-24T00:00:00Z",
  "source":{"id":"public-rules","licence":"Apache-2.0"},
  "kind":"prompt_injection",
  "rules":[{"id":"public-rule","category":"instruction_override","patterns":["synthetic amber lattice"],"minMatches":1}]
}
```

Run `node scripts/detection-feed-sign.mjs <feed.json> <ed25519-private.pem> <keyId>` on the signing machine. Its output
is the import request. No private key goes to the gateway, into a request or into a repository. The existing MCP
catalogue signing command and this command reuse one local signer. The document is signed byte-exact, including
format, feed identity, version and source. A newer version is a positive safe integer higher than the installed
watermark, and its signed `issuedAt` (UTC) must be later than the installed one and no more than five minutes ahead
of the gateway clock. One stream is pinned by the first accepted feed identity; changing that identity cannot reset
versioning.

Admin API:

- `POST /v1/detection-content/feed/import` accepts `{bundle,signature,keyId}`. Invalid trust, signatures, schemas,
  RE2 patterns, duplicate rule ids, unsupported kinds, replays and downgrades are refused and audited. All accepted
  content and its audit commit together. Replacing an enabled feed requires a fresh `settings_relax` proof bound to
  its new digest, version and current watermark.
- `PUT /v1/detection-content/feed/settings` accepts `{enabled:true|false}`. Both transitions need a fresh step-up.
  Enabling needs an installed document that still verifies. Disabling never clears the watermark or accepted bytes.
  Refusals (no step-up, unverifiable feed, missing state) are audited.
- `GET /v1/detection-content/feed` reports enabled/available (with `unavailableCode` when it does not verify),
  version, digest, key id, supported kinds, the signed `issuedAt`, its age in seconds, and `stale` once it is older
  than 30 days. It does
  not return the document or any matched text. Screens are owned by the design builders and tracked on #453.

**If the feed stops verifying, every governed call is blocked.** While the feed is enabled, the gateway uses its
rules only if the stored document still verifies under the currently trusted keys. The check runs again whenever the
row or the keyring changes, not on every call. If the stored bytes are corrupt, the active row is missing, the
watermark changed, or the signer's key was removed, the gateway fails closed: **every** governed call, in every phase,
is blocked with `feed_unavailable`. This holds whatever the prompt-injection mode, `off` included. The same
response-buffering flags prevent partial streaming while the block applies. Signs that this is happening:

- a warning in the gateway log at startup;
- `available:false` and an `unavailableCode` from `GET /v1/detection-content/feed`;
- a daily `health_unavailable` audit row.

To restore traffic, import a newer feed that verifies, or turn the feed off (step-up).

**Rotating keys safely:**

1. Add the new public key next to the old one.
2. Import a newer version signed by the new key.
3. Only then remove the old key.

Removing the old key first blocks all governed traffic until a feed signed by the new key is imported.

**Freshness.** There is no polling. If the installed feed's signed issue time is more than 30 days old, `stale` reads
true and the daily `detection-feed-health-sweep` writes a `health_stale` audit row. A stale feed keeps enforcing;
staleness is a prompt to import a newer one, not a block.

When the feed verifies, its rules follow the existing effective prompt-injection mode (including project compliance
floors). Turning the static injection pack off does not turn the separate feed off. With the feed off, no imported
rules run.

Limits: at most 64 rules, eight distinct patterns per rule, 2,048 characters per pattern, 64 KiB of combined pattern
bytes and a 256 KiB signed document. Every expression must compile with RE2 and must not match empty text. Matching
uses the existing normalisation and distinct-pattern/count semantics, and records category counts only. Detection
remains heuristic, not a claim that every attack will be caught. No automatic polling, key delegation, threshold
signatures, secret-pattern import or MCP-content import is provided by this format.
