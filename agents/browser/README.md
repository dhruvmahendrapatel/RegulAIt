# Managed browser extension (`agents/browser`)

[ADR-0334](../../internal/decisions/0334-managed-browser-extension-governance.md). Governs AI assistant sites in
browser tabs with the gateway's policy, audit trail and credential rules. Manifest V3, Chromium-based browsers
(version 137 or later) on macOS, Windows and Linux.

## What it does

- Blocks every governed AI site until a signed, unexpired policy from your gateway says otherwise (the `fail_closed`
  ruleset ships on).
- Blocks a site the policy denies, and a site allowed only for your organisation's accounts when the browser profile
  is signed in with another account.
- Stops a prompt that contains what looks like a password, key or token before it is sent, and records that it did,
  without the text.
- Shows a notice on governed sites while your organisation has prompt capture on, and only then sends prompts.

## What it cannot do

It has host access only to the governed sites (`src/manifest.ts`, pinned by `test/manifest.test.ts`). It never reads
browsing history, tabs, cookies or other sites. The only identity it reads is the browser profile's signed-in
account.

## Build

```bash
pnpm --filter @regulait/shared build
pnpm --filter @regulait/browser-extension typecheck
node agents/browser/scripts/build.mjs --gateway-origin https://gateway.example.com   # dist/ (unpacked), pinned to your gateway
pnpm --filter @regulait/browser-extension test
```

`--gateway-origin` is your gateway's public https origin (no path). It becomes the extension's only host permission
outside the governed sites, and a managed `gatewayUrl` with any other origin is refused. A build without it reaches no
gateway, so every governed site stays blocked.

`dist/` is the unpacked extension. Sign it into a CRX with your own key and host it on your own update URL; it is
never published to a store.

## Deploy (admin)

1. In RegulAIt, turn browser governance on (you are asked to confirm it's you). Allow the sites your organisation
   uses, with the account domains each needs.
2. Issue an enrolment token with a device cap. Copy the managed configuration shown once: `gatewayUrl`,
   `enrolmentToken` and `policyKeys`.
3. With your browser management (MDM or the browser's cloud management):
   - force-install the extension from your update URL (`ExtensionInstallForcelist` or `ExtensionSettings` with
     `installation_mode: force_installed`);
   - set the extension's managed configuration (`3rdparty` extension policy) to the values from step 2;
   - disable incognito and guest mode, or allow the extension in incognito, so a private window is not ungoverned;
   - require browser sign-in if your account rules depend on it.
4. Roll it out. Until a device has its first policy, governed sites show the block page.

To retire a device, revoke it; to stop new enrolments, revoke the token.
