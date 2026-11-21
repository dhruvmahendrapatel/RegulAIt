/** ADR-0334: the words the block page shows, by fixed code. British English, sentence case, no codes as labels. */
export interface BlockCopy {
  title: string;
  body: string;
}

const COPY: Record<string, BlockCopy> = {
  site_denied: { title: "This AI site is not allowed", body: "Your organisation does not allow this AI assistant. Use an approved assistant instead, or ask your administrator." },
  no_site_rule: { title: "This AI site has not been approved", body: "Your organisation has not approved this AI assistant yet. Ask your administrator if you need it." },
  execution_posture: { title: "AI use is paused", body: "Your organisation has paused AI use for now. Try again later, or ask your administrator." },
  account_not_recognised: { title: "Sign in with your work account", body: "AI sites are available only when the browser is signed in with an account your organisation recognises. Sign the browser in with your work account, or ask your administrator." },
  user_disabled: { title: "Your account cannot use AI sites", body: "Your organisation has turned off your account's access, so AI sites are blocked. Ask your administrator." },
  account_not_allowed: { title: "Use your work account", body: "This AI site is allowed only with your organisation's account. Sign the browser in with your work account and try again." },
  account_signed_out: { title: "Sign in to use this AI site", body: "This AI site is allowed only when the browser is signed in with your organisation's account." },
  site_not_in_policy: { title: "This AI site is blocked", body: "Your organisation's policy does not cover this AI site, so it is blocked." },
  no_valid_policy: { title: "AI sites are blocked for now", body: "This browser has no current AI use policy from your organisation, so AI sites stay blocked until it does. If this lasts, ask your administrator." },
};

export function blockCopy(code: string): BlockCopy {
  return COPY[code] ?? COPY.no_valid_policy!;
}

export const BLOCK_COPY_CODES = Object.keys(COPY);
