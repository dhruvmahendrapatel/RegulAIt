<!-- fold: pending -->

- **Apply a privacy-law preset from the console (ADR-0296 §7, #830 review).** `privacyPresetPatch` has no caller yet.
  The planned console action: pick one or more laws, preview the org-settings patch (it only tightens), and apply it
  through the existing `PUT /v1/org/settings`, which audits the change. No new route.
