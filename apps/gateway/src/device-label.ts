/**
 * ADR-0039 — the derived, NON-AUTHORITATIVE device label.
 *
 * A pure browser+OS family sniff over the stored user_agent, computed
 * server-side at list time purely so "Chrome on macOS · 10.0.4.2" is legible
 * in a session list. Explicitly NEVER a security control: the UA is
 * client-chosen text, there is no fingerprinting, and no device attribute is
 * ever an authentication factor — the session token remains the only
 * credential. Hand-rolled by design (no UA-parser dependency for a display
 * string); unrecognized agents degrade to honest "unknown" wording.
 */

function browserFamily(ua: string): string | null {
  // order matters: Chromium derivatives carry "Chrome/" and "Safari/" too
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\b(OPR|Opera)\//.test(ua)) return "Opera";
  if (/\bFirefox\//.test(ua) || /\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bCriOS\//.test(ua) || /\bChrome\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
  if (/^curl\//.test(ua)) return "curl";
  if (/^Wget\//i.test(ua)) return "wget";
  if (/\bPostmanRuntime\//.test(ua)) return "Postman";
  if (/^python-requests\//.test(ua)) return "python-requests";
  if (/^node(-fetch)?\b/i.test(ua) || /\bundici\b/.test(ua)) return "Node.js client";
  return null;
}

function osFamily(ua: string): string | null {
  if (/\biPhone\b|\biPod\b/.test(ua)) return "iOS";
  if (/\biPad\b/.test(ua)) return "iPadOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bWindows NT\b|\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "Linux";
  return null;
}

/** "Chrome on macOS", "curl", "Unknown device" — for the human-readable
 * session list only. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim();
  if (!ua) return "Unknown device";
  const browser = browserFamily(ua);
  const os = osFamily(ua);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Unknown browser on ${os}`;
  return "Unknown device";
}
