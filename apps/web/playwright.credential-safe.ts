/**
 * What a failing journey may keep, for every config whose specs type a real
 * password into the page (the seeded personas' one-time and settled passwords,
 * the ones `demo:prepare` printed). CI uploads `test-results/` when a journey
 * fails, so anything kept here is a published artifact.
 *
 *  - NO TRACE. A Playwright trace records every `fill()` value in its action log,
 *    and its DOM snapshots record every input's current value, password fields
 *    included (playwright-core's snapshotter copies `element.value` verbatim).
 *    Neither can be masked, so no trace is kept.
 *  - NO VIDEO. Not needed, and a video is the one artifact nobody reviews
 *    before it is shared.
 *  - A SCREENSHOT on failure. Password fields render as bullets, so a
 *    screenshot shows where the journey stopped without the value.
 */
export const CREDENTIAL_SAFE_ARTIFACTS = {
  trace: "off",
  video: "off",
  screenshot: "only-on-failure",
} as const;
