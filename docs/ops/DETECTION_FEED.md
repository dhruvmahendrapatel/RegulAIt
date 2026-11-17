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
  "source":{"id":"public-rules","licence":"Apache-2.0"},
  "kind":"prompt_injection",
  "rules":[{"id":"public-rule","category":"instruction_override","patterns":["synthetic amber lattice"],"minMatches":1}]
}
```

Run `node scripts/detection-feed-sign.mjs <feed.json> <ed25519-private.pem> <keyId>` on the signing machine. Its output
is the import request. No private key goes to the gateway, into a request or into a repository. The existing MCP
catalogue signing command and this command reuse one local signer. The document is signed byte-exact, including
format, feed identity, version and source. A newer version is a positive safe integer higher than the installed
watermark. One stream is pinned by the first accepted feed identity; changing that identity cannot reset versioning.

Admin API:

- `POST /v1/detection-content/feed/import` accepts `{bundle,signature,keyId}`. Invalid trust, signatures, schemas,
  RE2 patterns, duplicate rule ids, unsupported kinds, replays and downgrades are refused and audited. All accepted
  content and its audit commit together. Replacing an enabled feed requires a fresh `settings_relax` proof bound to
  its new digest, version and current watermark.
- `PUT /v1/detection-content/feed/settings` accepts `{enabled:true|false}`. Both transitions need a fresh step-up.
  Enabling needs an installed document that still verifies. Disabling never clears the watermark or accepted bytes.
- `GET /v1/detection-content/feed` reports enabled/available, version, digest, key id and supported kinds. It does
  not return the document or any matched text. Screens are owned by the design builders and tracked on #453.

Each governed call rechecks enabled content against the currently trusted keys before using its rules. Corrupt
stored bytes, a missing active row, a changed watermark or removal of its signer fails closed with a
`feed_unavailable` block. The same response-buffering flags prevent partial streaming while that block applies.
Off, no imported rules run. The feed's rules follow the existing effective prompt-injection mode (including project
compliance floors); turning the static injection pack off does not turn the separate feed off.

Limits: at most 64 rules, eight distinct patterns per rule, 2,048 characters per pattern, 64 KiB of combined pattern
bytes and a 256 KiB signed document. Every expression must compile with RE2 and must not match empty text. Matching
uses the existing normalisation and distinct-pattern/count semantics, and records category counts only. Detection
remains heuristic, not a claim that every attack will be caught. No automatic polling, key delegation, threshold
signatures, secret-pattern import or MCP-content import is provided by this format.
